import { TouchGestures } from './gestures';
import { icon } from './icons';
import type { PdfView } from './pdf';
import { line, recognize, type Shape, type XY } from './shapes';
import {
  HIGHLIGHT,
  LINE_GAP,
  PAGE_WIDTH,
  boxOf,
  fromSvg,
  hits,
  lassoed,
  makeStroke,
  outline,
  overlaps,
  picture,
  toSvg,
  transformed,
  union,
  type Box,
  type Brush,
  type Item,
  type Page,
  type Paper,
  type Picture,
  type Point,
  type Stroke,
} from './strokes';

export type Tool = 'pen' | 'highlighter' | 'eraser' | 'lasso';

/** Three colors to pick from, and a size, for the pen or the highlighter. */
export interface Palette {
  colors: string[];
  color: number;
  size: number;
}

/** Tool choices, remembered between visits. */
export interface InkTools {
  tool: Tool;
  pen: 'fountain' | 'ballpoint';
  pens: Palette;
  markers: Palette;
  /** Drawing a shape and holding the pen still snaps it to a clean line, ellipse or polygon. */
  snap: boolean;
  /** Paper for new notes: the last one picked. */
  paper: Paper;
}

/** What the editor needs from the app around it. */
export interface InkHost {
  /** Runs after each edit, and with `edited` false when only the selection changed. */
  changed(edited: boolean): void;
  /** Reads a photo or PDF from attachments/, or null if it isn't on this device yet. */
  file(path: string): Promise<Uint8Array<ArrayBuffer> | null>;
  problem(message: string): void;
}

const PEN_SIZES = [3, 4.5, 7];
const MARKER_SIZES = [14, 24, 36];

export const defaultTools = (): InkTools => ({
  tool: 'pen',
  pen: 'fountain',
  pens: { colors: ['#1a1a1a', '#2563eb', '#dc2626'], color: 0, size: 1 },
  markers: { colors: ['#facc15', '#4ade80', '#f472b6'], color: 0, size: 1 },
  snap: true,
  paper: 'lined',
});

/** Widest the page gets at 100% zoom, in CSS pixels. */
const MAX_PAGE = 992;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 6;
// These are in CSS pixels, so they feel the same at any zoom.
const ERASER = 10;
const HOLD_SLOP = 3;
const SELECT_PAD = 8;
const HANDLE = 22;
/** How long to hold the pen still to snap what you drew to a shape. */
const HOLD_TIME = 500;
/** PDF pages are white, so a note written on a PDF keeps light paper and true ink colors in dark mode. */
const LIGHT = { paper: '#ffffff', rule: '#e6ebf2', dot: '#c5ccd6' };

interface Change {
  added: Item[];
  removed: Item[];
}

/** What the pen is laying down. */
interface Ink {
  brush: Brush;
  color: string;
  size: number;
  opacity: number;
}

/** A selection being moved or resized: each point p goes to p * k + (tx, ty). */
interface Drag {
  mode: 'move' | 'scale';
  from: XY;
  k: number;
  tx: number;
  ty: number;
}

/**
 * A page you write on with Apple Pencil (or a mouse), drawn sharp at any zoom, optionally over a PDF and with photos.
 * The pen writes; fingers scroll, pinch to zoom, and tap with two or three fingers to undo or redo.
 * Notes are saved as plain SVG, so they also show up as images on GitHub.
 */
export class InkEditor {
  readonly el = document.createElement('div');
  /** The page and everything finished on it. */
  private base = document.createElement('canvas');
  /** What's in motion: the stroke being drawn, the lasso, the selection. Takes all input. */
  private top = document.createElement('canvas');
  private baseCtx = this.base.getContext('2d', { alpha: false })!;
  private topCtx = this.top.getContext('2d')!;
  private menu = document.createElement('div');
  private gestures: TouchGestures;

  private items: Item[] = [];
  private paths = new WeakMap<Stroke, Path2D>();
  private undos: Change[] = [];
  private redos: Change[] = [];
  /** The lowest the writing has reached. Erasing doesn't shrink the page out from under you. */
  private reach = 0;
  private paper: Paper = 'lined';
  private pdf: string | null = null;
  private pdfView: PdfView | null = null;
  /** Bumped on every load, so a PDF that finishes opening after you've moved on is dropped. */
  private loads = 0;
  private images = new Map<string, ImageBitmap | 'loading' | 'missing'>();

  // The page is `zoom` times as wide as fits the screen, scrolled so (x, y) is at the top left.
  private zoom = 1;
  private x = 0;
  private y = 0;
  private w = 0;
  private h = 0;
  private rect = new DOMRect();
  private dark = matchMedia('(prefers-color-scheme: dark)');
  private theme: Record<'bg' | 'paper' | 'rule' | 'dot' | 'muted' | 'accent', string> | null = null;
  private shades = new Map<string, string>();

  // What the pen (or mouse, or a finger dragging a selection) is doing.
  private pointer: number | null = null;
  private drawing: Ink | null = null;
  private pressure = false;
  private points: Point[] = [];
  private predicted: Point[] = [];
  private time = 0;
  private shape: Shape | null = null;
  private hold = 0;
  private anchor: XY = [0, 0];
  private erased: Set<Stroke> | null = null;
  private cursor: XY | null = null;
  private lasso: number[] | null = null;
  private selection: Item[] = [];
  private selBox: Box = [0, 0, 0, 0];
  private drag: Drag | null = null;

  private frame = 0;
  private dirtyBase = false;

  constructor(
    private tools: InkTools,
    private host: InkHost,
  ) {
    this.el.className = 'ink';
    this.top.className = 'surface';
    this.menu.className = 'selection-menu';
    this.menu.hidden = true;
    const remove = document.createElement('button');
    remove.className = 'icon';
    remove.innerHTML = icon('trash');
    remove.setAttribute('aria-label', 'Delete selection');
    remove.onclick = () => this.deleteSelection();
    this.menu.append(remove);
    this.el.append(this.base, this.top, this.menu);

    this.gestures = new TouchGestures({
      pan: (dx, dy) => this.pan(dx, dy),
      zoom: (factor, x, y) => this.zoomAt(factor, x, y),
      tap: (fingers) => (fingers === 2 ? this.undo() : fingers === 3 ? this.redo() : undefined),
    });
    this.top.addEventListener('pointerdown', this.down);
    this.top.addEventListener('pointermove', this.move);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) this.top.addEventListener(type, this.up);
    // No native scrolling, zooming, magnifier or callouts on the page: every gesture is handled here.
    for (const type of ['touchstart', 'touchmove', 'gesturestart']) {
      this.top.addEventListener(type, (e) => e.preventDefault(), { passive: false });
    }
    this.el.addEventListener('wheel', this.wheel, { passive: false });
    this.dark.addEventListener('change', () => {
      this.theme = null;
      this.shades.clear();
      this.invalidate();
    });
    new ResizeObserver(() => this.measure()).observe(this.el);
  }

  get empty() {
    return this.items.length === 0;
  }
  /** A stroke is in progress. */
  get busy() {
    return this.pointer !== null;
  }
  get canUndo() {
    return this.undos.length > 0;
  }
  get canRedo() {
    return this.redos.length > 0;
  }
  get hasSelection() {
    return this.selection.length > 0;
  }
  get currentPaper() {
    return this.paper;
  }
  get hasPdf() {
    return this.pdf !== null;
  }

  /** Shows a note. `keepView` keeps the zoom and scroll, for when the same note changed on another device. */
  load(svg: string, keepView = false) {
    this.cancel();
    const page = fromSvg(svg);
    this.items = page.items;
    this.paper = svg.trim() ? page.paper : this.tools.paper;
    this.undos = [];
    this.redos = [];
    this.selection = [];
    this.reach = 0;
    this.theme = null;
    this.shades.clear();
    // Let go of photos this note doesn't use.
    const used = new Set(this.items.map((i) => (i.type === 'picture' ? i.src : '')));
    for (const [src, image] of this.images) {
      if (used.has(src)) continue;
      if (image instanceof ImageBitmap) image.close();
      this.images.delete(src);
    }
    if (page.pdf !== this.pdf || !this.pdfView) {
      this.pdfView?.destroy();
      this.pdfView = null;
      delete this.el.dataset.pdfPages;
      this.pdf = page.pdf;
      this.loads++;
      if (this.pdf) void this.openPdf(this.pdf);
    }
    if (!keepView) {
      this.zoom = 1;
      this.y = 0;
    }
    this.measure();
    this.updated();
  }

  serialize(): string {
    const bottom = this.items.reduce((max, i) => Math.max(max, i.box[3]), 0);
    return toSvg(this.page(), Math.ceil(Math.max(bottom + LINE_GAP, 2 * LINE_GAP, this.pdfView?.height ?? 0)));
  }

  /** The note's contents, for exporting. */
  page(): Page {
    return { paper: this.paper, pdf: this.pdf, items: this.items };
  }

  setTool(tool: Tool) {
    this.tools.tool = tool;
    this.select([]);
  }

  setPaper(paper: Paper) {
    if (paper === this.paper) return;
    this.paper = paper;
    this.invalidate();
    this.host.changed(true);
  }

  /** Puts a photo in the middle of the screen, selected so it can be moved and resized straight away. */
  insertPicture(src: string, width: number, height: number) {
    const s = this.scale;
    const left = Math.max(this.x, 0);
    const right = Math.min(this.x + this.w / s, PAGE_WIDTH);
    let w = Math.min(PAGE_WIDTH * 0.6, (right - left) * 0.8);
    let h = (w * height) / width;
    const most = (this.h / s) * 0.7;
    if (h > most) [w, h] = [(most * width) / height, most];
    const cx = (left + right) / 2;
    const cy = this.y + this.h / s / 2;
    const item = picture(src, [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]);
    this.commit({ added: [item], removed: [] });
    this.tools.tool = 'lasso';
    this.select([item]);
  }

  /** Tries again to show photos or a PDF that weren't on this device yet. */
  reloadFiles() {
    for (const [src, image] of this.images) if (image === 'missing') this.images.delete(src);
    if (this.pdf && !this.pdfView) void this.openPdf(this.pdf);
    this.invalidate();
  }

  undo() {
    const change = this.undos.pop();
    if (!change) return;
    this.select([]);
    this.apply(change.removed, change.added);
    this.redos.push(change);
    this.host.changed(true);
  }

  redo() {
    const change = this.redos.pop();
    if (!change) return;
    this.select([]);
    this.apply(change.added, change.removed);
    this.undos.push(change);
    this.host.changed(true);
  }

  /** Recolors the selected writing. Photos keep their colors. */
  recolor(color: string) {
    const old = this.selection.filter((i) => i.type === 'stroke');
    if (!old.length) return;
    const next = old.map((s) => makeStroke(color, s.d, s.opacity));
    this.commit({ added: next, removed: old });
    this.select([...this.selection.filter((i) => i.type === 'picture'), ...next]);
  }

  deleteSelection() {
    const removed = this.selection;
    if (!removed.length) return;
    this.select([]);
    this.commit({ added: [], removed });
  }

  clearSelection() {
    this.select([]);
  }

  // ---------- Input

  private down = (e: PointerEvent) => {
    this.rect = this.top.getBoundingClientRect();
    if (e.pointerType === 'touch') {
      // A finger can drag a selection around. Otherwise fingers scroll and zoom.
      const grabbing = this.tools.tool === 'lasso' && this.pointer === null && !this.gestures.active;
      if (grabbing && this.grab(this.toPage(e))) return this.begin(e, 'lasso');
      return this.gestures.down(e, e.clientX - this.rect.left, e.clientY - this.rect.top);
    }
    if (this.pointer !== null || (e.button !== 0 && e.button !== 5)) return;
    e.preventDefault();
    // Button 5 is the eraser end of pens that have one.
    this.begin(e, e.button === 5 ? 'eraser' : this.tools.tool);
  };

  private begin(e: PointerEvent, tool: Tool) {
    this.pointer = e.pointerId;
    this.top.setPointerCapture(e.pointerId);
    this.gestures.penDown();
    const p = this.toPage(e);
    if (tool === 'lasso') {
      const grab = this.grab(p);
      if (grab) this.drag = { mode: grab, from: p, k: 1, tx: 0, ty: 0 };
      else {
        this.select([]);
        this.lasso = [...p];
      }
    } else if (tool === 'eraser') {
      this.select([]);
      this.erased = new Set();
      this.cursor = p;
      if (this.erase(p)) this.invalidate();
    } else {
      this.select([]);
      this.drawing = this.currentInk();
      this.pressure = e.pointerType === 'pen';
      this.points = [this.point(e, p)];
      this.armHold(p);
    }
    this.invalidate(false);
  }

  private move = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) {
      if (e.pointerType === 'touch') this.gestures.move(e, e.clientX - this.rect.left, e.clientY - this.rect.top);
      return;
    }
    // Coalesced events carry the Pencil's full sample rate, which keeps fast strokes smooth.
    const events = e.getCoalescedEvents?.() ?? [];
    let erased = false;
    for (const ev of events.length ? events : [e]) erased = this.extend(ev) || erased;
    if (this.drawing && !this.shape) {
      // Predicted points (drawn but never saved) make the line keep up with the pen.
      const pressure = this.points[this.points.length - 1][2];
      this.predicted = (e.getPredictedEvents?.() ?? []).map((ev): Point => [...this.toPage(ev), pressure]);
    }
    this.invalidate(erased);
  };

  private up = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) {
      if (e.pointerType === 'touch') this.gestures.up(e);
      return;
    }
    this.pointer = null;
    clearTimeout(this.hold);
    this.gestures.penUp(e.timeStamp);
    this.finish();
  };

  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    this.gestures.stop();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.h : 1;
    const rect = this.top.getBoundingClientRect();
    // Trackpad pinches arrive as wheel events with ctrlKey set.
    if (e.ctrlKey || e.metaKey) {
      const delta = Math.max(-50, Math.min(50, e.deltaY * unit));
      this.zoomAt(Math.exp(-delta * 0.01), e.clientX - rect.left, e.clientY - rect.top);
    } else this.pan(-e.deltaX * unit, -e.deltaY * unit);
  };

  /** Adds an input sample to whatever's in progress. Returns true if strokes were erased. */
  private extend(e: PointerEvent): boolean {
    const p = this.toPage(e);
    if (this.drag) this.dragTo(p);
    else if (this.lasso) this.lasso.push(...p);
    else if (this.erased) return this.eraseTo(p);
    else if (this.shape) {
      // A snapped line keeps following the pen until it lifts.
      if (this.shape.kind === 'line') this.shape = line(this.shape.points[0], p);
    } else if (this.drawing) {
      this.points.push(this.point(e, p));
      if (Math.hypot(p[0] - this.anchor[0], p[1] - this.anchor[1]) * this.scale > HOLD_SLOP) this.armHold(p);
    }
    return false;
  }

  private finish() {
    if (this.drag) {
      const { k, tx, ty } = this.drag;
      this.drag = null;
      if (k !== 1 || tx || ty) {
        const moved = this.selection.map((i) => transformed(i, k, tx, ty));
        this.commit({ added: moved, removed: this.selection });
        this.select(moved);
      }
    } else if (this.lasso) {
      const lasso = this.lasso;
      this.lasso = null;
      const area = boxOf(lasso);
      if ((area[2] - area[0] + (area[3] - area[1])) * this.scale < 12) {
        // A tap selects the photo under it.
        const [x, y] = lasso;
        const hit = [...this.items].reverse().find((i) => i.type === 'picture' && overlaps(i.box, [x, y, x, y]));
        this.select(hit ? [hit] : []);
      } else this.select(this.items.filter((i) => overlaps(i.box, area) && lassoed(i, lasso)));
    } else if (this.erased) {
      const removed = [...this.erased];
      this.erased = null;
      this.cursor = null;
      if (removed.length) this.commit({ added: [], removed });
    } else if (this.drawing) {
      const { brush, color, size, opacity } = this.drawing;
      const d = this.shape
        ? outline(this.shape.points.map(([x, y]) => [x, y, 0.5]), brush, size, { exact: true })
        : outline(this.points, brush, size, { pressure: this.pressure });
      this.cancel();
      if (d) this.commit({ added: [makeStroke(color, d, opacity)], removed: [] });
    }
    this.invalidate(false);
  }

  /** Drops whatever was in progress. */
  private cancel() {
    clearTimeout(this.hold);
    this.pointer = null;
    this.drawing = null;
    this.points = [];
    this.predicted = [];
    this.shape = null;
    this.erased = null;
    this.cursor = null;
    this.lasso = null;
    this.drag = null;
  }

  private currentInk(): Ink {
    const { tool, pen, pens, markers } = this.tools;
    if (tool === 'highlighter') {
      return { brush: 'highlighter', color: markers.colors[markers.color], size: MARKER_SIZES[markers.size], opacity: HIGHLIGHT };
    }
    return { brush: pen, color: pens.colors[pens.color], size: PEN_SIZES[pens.size], opacity: 1 };
  }

  private point(e: PointerEvent, [x, y]: XY): Point {
    if (!this.pressure) return [x, y, 0.5];
    const prev = this.points[this.points.length - 1];
    const raw = e.pressure || prev?.[2] || 0.5;
    // Pencil pressure jitters from sample to sample. Easing it in keeps the edges of the line smooth.
    const ease = prev ? 1 - Math.exp(-Math.max(0, e.timeStamp - this.time) / 20) : 1;
    this.time = e.timeStamp;
    return [x, y, prev ? prev[2] + (raw - prev[2]) * ease : raw];
  }

  private toPage(e: PointerEvent): XY {
    const s = this.scale;
    return [(e.clientX - this.rect.left) / s + this.x, (e.clientY - this.rect.top) / s + this.y];
  }

  /** Restarts the hold-to-snap timer: the pen has moved, so it isn't holding still yet. */
  private armHold(p: XY) {
    this.anchor = p;
    clearTimeout(this.hold);
    if (this.tools.snap) this.hold = window.setTimeout(this.snap, HOLD_TIME);
  }

  private snap = () => {
    if (!this.drawing || this.shape) return;
    this.shape = recognize(this.points.map(([x, y]): XY => [x, y]));
    if (this.shape) this.invalidate(false);
  };

  /** Erases along the line from the last eraser position, so fast swipes don't skip strokes. */
  private eraseTo(p: XY): boolean {
    const [lx, ly] = this.cursor ?? p;
    const step = ERASER / this.scale / 2;
    const steps = Math.max(1, Math.ceil(Math.hypot(p[0] - lx, p[1] - ly) / step));
    let erased = false;
    for (let i = 1; i <= steps; i++) erased = this.erase([lx + ((p[0] - lx) * i) / steps, ly + ((p[1] - ly) * i) / steps]) || erased;
    this.cursor = p;
    return erased;
  }

  /** Erases writing under (x, y). Photos stay: they're removed with the lasso. */
  private erase([x, y]: XY): boolean {
    let erased = false;
    for (const s of this.items) {
      if (s.type === 'stroke' && !this.erased!.has(s) && hits(s, x, y, ERASER / this.scale)) {
        this.erased!.add(s);
        erased = true;
      }
    }
    return erased;
  }

  /** Where a press lands on the selection: its resize handle, inside it, or neither. */
  private grab([x, y]: XY): Drag['mode'] | null {
    if (!this.selection.length) return null;
    const pad = SELECT_PAD / this.scale;
    const [x0, y0, x1, y1] = this.selBox;
    if (Math.hypot(x - x1 - pad, y - y1 - pad) * this.scale < HANDLE) return 'scale';
    return x > x0 - pad && x < x1 + pad && y > y0 - pad && y < y1 + pad ? 'move' : null;
  }

  private dragTo([x, y]: XY) {
    const d = this.drag!;
    if (d.mode === 'move') {
      d.tx = x - d.from[0];
      d.ty = y - d.from[1];
      return;
    }
    // Resize from the top-left corner, keeping proportions.
    const [x0, y0] = this.selBox;
    const span = d.from[0] - x0 + (d.from[1] - y0);
    if (span <= 0) return;
    d.k = Math.min(10, Math.max(0.1, (x - x0 + (y - y0)) / span));
    d.tx = x0 * (1 - d.k);
    d.ty = y0 * (1 - d.k);
  }

  private select(items: Item[]) {
    if (!items.length && !this.selection.length) return;
    this.selection = items;
    this.selBox = union(items.map((i) => i.box));
    this.invalidate();
    this.host.changed(false);
  }

  // ---------- Edits

  private commit(change: Change) {
    this.apply(change.added, change.removed);
    this.undos.push(change);
    this.redos = [];
    this.host.changed(true);
  }

  private apply(added: Item[], removed: Item[]) {
    const gone = new Set(removed);
    this.items = this.items.filter((i) => !gone.has(i)).concat(added);
    this.updated();
  }

  private updated() {
    this.reach = this.items.reduce((max, i) => Math.max(max, i.box[3]), this.reach);
    this.el.dataset.items = String(this.items.length);
    this.clamp();
    this.invalidate();
  }

  private async openPdf(src: string) {
    const load = this.loads;
    try {
      const bytes = await this.host.file(src);
      if (!bytes) return; // Not synced to this device yet: reloadFiles tries again after the next sync.
      const { PdfView } = await import('./pdf');
      const view = await PdfView.open(bytes, () => this.invalidate());
      if (load !== this.loads) return view.destroy();
      this.pdfView = view;
      this.el.dataset.pdfPages = String(view.pages.length);
      this.updated();
    } catch (e) {
      if (load === this.loads) this.host.problem(`Couldn’t open this PDF: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** The photo, or null while it loads or if it isn't on this device yet. */
  private image(src: string): ImageBitmap | null {
    const image = this.images.get(src);
    if (image instanceof ImageBitmap) return image;
    if (!image) {
      this.images.set(src, 'loading');
      void this.loadImage(src);
    }
    return null;
  }

  private async loadImage(src: string) {
    let image: ImageBitmap | 'missing' = 'missing';
    try {
      const bytes = await this.host.file(src);
      if (bytes) image = await createImageBitmap(new Blob([bytes]));
    } catch {
      // Unreadable: shows as a placeholder.
    }
    // The note may have changed while it loaded.
    if (this.images.get(src) === 'loading') this.images.set(src, image);
    else if (image instanceof ImageBitmap) image.close();
    this.invalidate();
  }

  // ---------- View

  /** CSS pixels per page unit at 100% zoom. */
  private get fit() {
    return Math.min(this.w, MAX_PAGE) / PAGE_WIDTH;
  }

  private get scale() {
    return this.fit * this.zoom;
  }

  /** The page always reaches 3/4 of a screen below the writing, and past the PDF, so there's room to keep going. */
  private pageHeight() {
    const screen = this.h / this.fit;
    const pdf = this.pdfView ? this.pdfView.height + screen / 2 : 0;
    return Math.max(screen, this.reach + screen * 0.75, pdf);
  }

  private measure() {
    this.w = this.el.clientWidth;
    this.h = this.el.clientHeight;
    this.clamp();
    this.invalidate();
  }

  private pan(dx: number, dy: number) {
    this.x -= dx / this.scale;
    this.y -= dy / this.scale;
    this.clamp();
    this.invalidate();
  }

  /** Zooms by `factor`, keeping the page point under (sx, sy) in place. */
  private zoomAt(factor: number, sx: number, sy: number) {
    const s = this.scale;
    const px = this.x + sx / s;
    const py = this.y + sy / s;
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    this.x = px - sx / this.scale;
    this.y = py - sy / this.scale;
    this.clamp();
    this.invalidate();
  }

  /** Keeps the page on screen, centered when it's narrower than the screen. */
  private clamp() {
    this.el.dataset.zoom = this.zoom.toFixed(2);
    if (!this.w) return;
    const viewW = this.w / this.scale;
    const viewH = this.h / this.scale;
    this.x = viewW >= PAGE_WIDTH ? (PAGE_WIDTH - viewW) / 2 : Math.min(Math.max(this.x, 0), PAGE_WIDTH - viewW);
    this.y = Math.min(Math.max(this.y, 0), Math.max(0, this.pageHeight() - viewH));
  }

  // ---------- Drawing

  private invalidate(base = true) {
    this.dirtyBase ||= base;
    if (!this.frame) this.frame = requestAnimationFrame(() => this.render());
  }

  private render() {
    this.frame = 0;
    if (!this.w || !this.h) return;
    const dpr = devicePixelRatio || 1;
    for (const canvas of [this.base, this.top]) {
      const w = Math.round(this.w * dpr);
      const h = Math.round(this.h * dpr);
      if (canvas.width === w && canvas.height === h) continue;
      canvas.width = w;
      canvas.height = h;
      this.dirtyBase = true;
    }
    if (this.dirtyBase) this.renderBase(dpr);
    this.dirtyBase = false;
    this.renderTop(dpr);
  }

  private renderBase(dpr: number) {
    const ctx = this.baseCtx;
    const theme = this.colors();
    const s = this.scale;
    const view: Box = [this.x, this.y, this.x + this.w / s, this.y + this.h / s];
    const height = this.pageHeight();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.fillStyle = theme.paper;
    ctx.fillRect(-this.x * s, -this.y * s, PAGE_WIDTH * s, height * s);

    // A PDF's pages come first, with the background showing between them; the paper continues below.
    let paperTop = 0;
    if (this.pdfView) {
      paperTop = this.pdfView.height + LINE_GAP / 2;
      ctx.fillStyle = theme.bg;
      ctx.fillRect(-this.x * s, -this.y * s, PAGE_WIDTH * s, this.pdfView.height * s);
    } else if (this.pdf) {
      ctx.fillStyle = theme.muted;
      ctx.font = '15px -apple-system, system-ui, sans-serif';
      ctx.fillText('Opening PDF…', (24 - this.x) * s, (40 - this.y) * s);
    }
    this.drawPaper(ctx, dpr, theme, Math.max(paperTop, view[1]), Math.min(height, view[3]));

    ctx.setTransform(dpr * s, 0, 0, dpr * s, -dpr * s * this.x, -dpr * s * this.y);
    this.pdfView?.draw(ctx, view, dpr * s);
    const skip = new Set<Item>([...this.selection, ...(this.erased ?? [])]);
    this.fill(
      ctx,
      this.items.filter((i) => !skip.has(i) && overlaps(i.box, view)),
    );
  }

  /** Lines, a grid or dots between page heights y0 and y1, kept crisp on device pixels at any zoom. */
  private drawPaper(ctx: CanvasRenderingContext2D, dpr: number, theme: { rule: string; dot: string }, y0: number, y1: number) {
    if (this.paper === 'blank' || y1 <= y0) return;
    const s = this.scale;
    const snap = (v: number) => Math.round(v * dpr) / dpr;
    const left = -this.x * s;
    const first = Math.max(1, Math.ceil(y0 / LINE_GAP));
    const last = Math.floor(y1 / LINE_GAP);
    if (this.paper === 'dotted') {
      // Dots grow a little as you zoom in, like a real page.
      const r = Math.min(3, Math.max(1, 1.2 * s));
      ctx.fillStyle = theme.dot;
      ctx.beginPath();
      for (let j = first; j <= last; j++) {
        for (let i = 1; i < PAGE_WIDTH / LINE_GAP; i++) {
          const x = left + i * LINE_GAP * s;
          if (x < -r || x > this.w + r) continue;
          ctx.moveTo(x + r, (j * LINE_GAP - this.y) * s);
          ctx.arc(x, (j * LINE_GAP - this.y) * s, r, 0, 2 * Math.PI);
        }
      }
      ctx.fill();
      return;
    }
    ctx.fillStyle = theme.rule;
    for (let j = first; j <= last; j++) ctx.fillRect(left, snap((j * LINE_GAP - this.y) * s), PAGE_WIDTH * s, 1);
    if (this.paper === 'grid') {
      const top = snap((y0 - this.y) * s);
      for (let i = 1; i < PAGE_WIDTH / LINE_GAP; i++) ctx.fillRect(snap(left + i * LINE_GAP * s), top, 1, (y1 - y0) * s);
    }
  }

  private renderTop(dpr: number) {
    const ctx = this.topCtx;
    const theme = this.colors();
    const s = this.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.top.width, this.top.height);
    // Page units to device pixels, with items scaled by k and moved by (tx, ty).
    const page = (k = 1, tx = 0, ty = 0) =>
      ctx.setTransform(dpr * s * k, 0, 0, dpr * s * k, dpr * s * (tx - this.x), dpr * s * (ty - this.y));
    const screen = () => ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const toScreen = (x: number, y: number): XY => [(x - this.x) * s, (y - this.y) * s];

    if (this.drawing) {
      const { brush, color, size, opacity } = this.drawing;
      const d = this.shape
        ? outline(this.shape.points.map(([x, y]) => [x, y, 0.5]), brush, size, { exact: true })
        : outline([...this.points, ...this.predicted], brush, size, { pressure: this.pressure, last: false });
      if (d) {
        page();
        ctx.globalAlpha = opacity;
        ctx.fillStyle = this.shade(color);
        ctx.fill(new Path2D(d));
        ctx.globalAlpha = 1;
      }
    }

    if (this.erased && this.cursor) {
      screen();
      ctx.beginPath();
      ctx.arc(...toScreen(...this.cursor), ERASER, 0, 2 * Math.PI);
      ctx.strokeStyle = theme.muted;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (this.lasso) {
      screen();
      ctx.beginPath();
      for (let i = 0; i < this.lasso.length; i += 2) ctx.lineTo(...toScreen(this.lasso[i], this.lasso[i + 1]));
      ctx.closePath();
      ctx.globalAlpha = 0.06;
      ctx.fillStyle = theme.accent;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    this.menu.hidden = !this.selection.length || this.drag !== null;
    if (this.selection.length) {
      const { k, tx, ty } = this.drag ?? { k: 1, tx: 0, ty: 0 };
      page(k, tx, ty);
      this.fill(ctx, this.selection);
      screen();
      const [x0, y0, x1, y1] = this.selBox;
      const [sx0, sy0] = toScreen(x0 * k + tx, y0 * k + ty).map((v) => v - SELECT_PAD);
      const [sx1, sy1] = toScreen(x1 * k + tx, y1 * k + ty).map((v) => v + SELECT_PAD);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(sx1, sy1, 7, 0, 2 * Math.PI);
      ctx.fillStyle = theme.paper;
      ctx.fill();
      ctx.stroke();
      // The menu goes under the selection, or over it if there's no room below.
      this.menu.style.left = `${Math.min(Math.max((sx0 + sx1) / 2, 32), this.w - 32)}px`;
      this.menu.style.top = `${sy1 + 64 < this.h ? sy1 + 12 : Math.max(8, sy0 - 56)}px`;
    }
  }

  /** Draws items: photos, then highlighter, then ink on top. */
  private fill(ctx: CanvasRenderingContext2D, items: Item[]) {
    ctx.imageSmoothingQuality = 'high';
    for (const p of items.filter((i): i is Picture => i.type === 'picture')) {
      const [x0, y0, x1, y1] = p.box;
      const image = this.image(p.src);
      if (image) ctx.drawImage(image, x0, y0, x1 - x0, y1 - y0);
      else {
        ctx.fillStyle = this.colors().rule;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
    }
    for (const marker of [true, false]) {
      for (const s of items) {
        if (s.type !== 'stroke' || s.opacity < 1 !== marker) continue;
        let path = this.paths.get(s);
        if (!path) this.paths.set(s, (path = new Path2D(s.d)));
        ctx.globalAlpha = s.opacity;
        ctx.fillStyle = this.shade(s.color);
        ctx.fill(path);
      }
    }
    ctx.globalAlpha = 1;
  }

  private colors() {
    if (!this.theme) {
      const style = getComputedStyle(document.documentElement);
      const get = (name: string) => style.getPropertyValue(`--${name}`).trim();
      this.theme = {
        bg: get('bg'),
        paper: get('paper'),
        rule: get('rule'),
        dot: get('dot'),
        muted: get('muted'),
        accent: get('accent'),
        ...(this.pdf ? LIGHT : {}),
      };
    }
    return this.theme;
  }

  private shade(color: string) {
    let shade = this.shades.get(color);
    if (!shade) this.shades.set(color, (shade = displayColor(color, this.dark.matches && !this.pdf)));
    return shade;
  }
}

/**
 * How an ink color looks on screen. In dark mode, dark ink turns light and bright ink lightens, so everything
 * stays readable. Files always keep the real colors.
 */
export function displayColor(color: string, dark: boolean): string {
  const m = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!dark || !m) return color;
  const [r, g, b] = m.slice(1).map((hex) => parseInt(hex, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const c = max - min;
  const s = c === 0 ? 0 : c / (1 - Math.abs(2 * l - 1));
  const h = c === 0 ? 0 : max === r ? ((g - b) / c + 6) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
  const light = Math.max(0.65, l < 0.5 ? 1 - l : l);
  return `hsl(${Math.round(h * 60)}, ${Math.round(s * 100)}%, ${Math.round(light * 100)}%)`;
}
