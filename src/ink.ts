import { getStroke } from 'perfect-freehand';

/** Page width in SVG units. Pages scale to fit the screen, so a note looks the same on every device. */
const PAGE_WIDTH = 1000;
const LINE_GAP = 40;
const ERASER_RADIUS = 10;
const STROKE = { size: 4.5, thinning: 0.6, smoothing: 0.5, streamline: 0.4 };
export const INK_COLORS = ['#1a1a1a', '#2563eb', '#dc2626'];

const NS = 'http://www.w3.org/2000/svg';
const NUMBER = /-?\d+(?:\.\d+)?/g;
const SAFE_PATH = /^[MQTZ\d\s.,-]+$/;
const SAFE_COLOR = /^#[0-9a-f]{3,8}$/i;

type Point = [x: number, y: number, pressure: number];

interface Stroke {
  el: SVGPathElement;
  color: string;
  d: string;
  /** Outline polygon as flat x,y pairs, for eraser hit tests. */
  poly: number[];
  box: [x0: number, y0: number, x1: number, y1: number];
}

interface Change {
  added: Stroke[];
  removed: Stroke[];
}

/**
 * A lined page you write on with Apple Pencil (or a mouse). Fingers scroll; only the pen draws.
 * Notes are saved as plain SVG, so they also show up as images on GitHub.
 */
export class InkEditor {
  readonly el = document.createElement('div');
  tool: 'pen' | 'eraser' = 'pen';
  color = INK_COLORS[0];

  private svg = document.createElementNS(NS, 'svg');
  private layer = document.createElementNS(NS, 'g');
  private strokes: Stroke[] = [];
  private undos: Change[] = [];
  private redos: Change[] = [];
  private height = 0;
  private rect = new DOMRect();
  private pointer: number | null = null;
  private pen = false;
  private points: Point[] = [];
  private live: SVGPathElement | null = null;
  private erased: Stroke[] | null = null;
  private last = [0, 0];
  private frame = 0;

  constructor(private onChange: () => void) {
    this.el.className = 'ink';
    this.svg.innerHTML =
      `<defs><pattern id="ink-rule" width="${PAGE_WIDTH}" height="${LINE_GAP}" patternUnits="userSpaceOnUse">` +
      `<line class="rule" x1="0" x2="${PAGE_WIDTH}" y1="${LINE_GAP - 0.5}" y2="${LINE_GAP - 0.5}"/></pattern></defs>` +
      `<rect width="100%" height="100%" fill="url(#ink-rule)"/>`;
    this.svg.append(this.layer);
    this.el.append(this.svg);

    this.svg.addEventListener('pointerdown', this.down);
    this.svg.addEventListener('pointermove', this.move);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) this.svg.addEventListener(type, this.up);
    // iPad: fingers scroll the page natively, but the Pencil must not scroll while it writes.
    const stopPencilScroll = (e: TouchEvent) => {
      if ([...e.touches].some((t) => (t as Touch & { touchType?: string }).touchType === 'stylus')) e.preventDefault();
    };
    this.svg.addEventListener('touchstart', stopPencilScroll, { passive: false });
    this.svg.addEventListener('touchmove', stopPencilScroll, { passive: false });
    new ResizeObserver(() => this.layout()).observe(this.el);
  }

  get empty() {
    return this.strokes.length === 0;
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

  load(svg: string) {
    this.layer.replaceChildren();
    this.strokes = [];
    this.undos = [];
    this.redos = [];
    if (svg.trim()) {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      for (const p of doc.querySelectorAll('path')) {
        const d = p.getAttribute('d') ?? '';
        const fill = p.getAttribute('fill') ?? '';
        if (!SAFE_PATH.test(d)) continue;
        const stroke = toStroke(SAFE_COLOR.test(fill) ? fill : INK_COLORS[0], d);
        this.layer.append(stroke.el);
        this.strokes.push(stroke);
      }
    }
    this.layout();
    this.el.scrollTop = 0;
  }

  serialize(): string {
    const h = Math.ceil(Math.max(this.bottom() + LINE_GAP, 2 * LINE_GAP));
    const paths = this.strokes.map((s) => `<path fill="${s.color}" d="${s.d}"/>\n`).join('');
    return (
      `<svg xmlns="${NS}" width="${PAGE_WIDTH}" height="${h}" viewBox="0 0 ${PAGE_WIDTH} ${h}">\n` +
      `<rect width="100%" height="100%" fill="#fff"/>\n${paths}</svg>\n`
    );
  }

  undo() {
    const change = this.undos.pop();
    if (!change) return;
    this.apply(change.removed, change.added);
    this.redos.push(change);
    this.onChange();
  }

  redo() {
    const change = this.redos.pop();
    if (!change) return;
    this.apply(change.added, change.removed);
    this.undos.push(change);
    this.onChange();
  }

  private down = (e: PointerEvent) => {
    // Touch never draws: that is what lets fingers scroll and the palm rest on the screen.
    if (this.pointer !== null || e.pointerType === 'touch' || (e.button !== 0 && e.button !== 5)) return;
    e.preventDefault();
    this.svg.setPointerCapture(e.pointerId);
    this.pointer = e.pointerId;
    this.pen = e.pointerType === 'pen';
    this.rect = this.svg.getBoundingClientRect();
    const p = this.at(e);
    // button 5 is the eraser end of pens that have one.
    if (this.tool === 'eraser' || e.button === 5) {
      this.erased = [];
      this.last = [p[0], p[1]];
      this.erase(p[0], p[1]);
      return;
    }
    this.points = [p];
    this.live = document.createElementNS(NS, 'path');
    this.live.setAttribute('fill', this.color);
    this.layer.append(this.live);
    this.draw();
  };

  private move = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) return;
    // Coalesced events carry the Pencil's full sample rate, which keeps fast strokes smooth.
    const events = e.getCoalescedEvents?.() ?? [];
    for (const ev of events.length ? events : [e]) {
      const p = this.at(ev);
      if (this.erased) this.eraseTo(p[0], p[1]);
      else this.points.push(p);
    }
    if (!this.erased && !this.frame) this.frame = requestAnimationFrame(() => this.draw());
  };

  private up = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) return;
    this.pointer = null;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.erased) {
      const removed = this.erased;
      this.erased = null;
      if (removed.length) this.commit({ added: [], removed });
      return;
    }
    const live = this.live!;
    this.live = null;
    live.remove();
    const d = outline(this.points, this.pen, true);
    if (d) this.commit({ added: [toStroke(this.color, d)], removed: [] });
  };

  private draw() {
    this.frame = 0;
    this.live?.setAttribute('d', outline(this.points, this.pen, false));
  }

  private at(e: PointerEvent): Point {
    const scale = PAGE_WIDTH / this.rect.width;
    const pressure = this.pen ? Math.max(e.pressure, 0.05) : 0.5;
    return [(e.clientX - this.rect.left) * scale, (e.clientY - this.rect.top) * scale, pressure];
  }

  /** Erases along the line from the last eraser position, so fast swipes don't skip strokes. */
  private eraseTo(x: number, y: number) {
    const [lx, ly] = this.last;
    const steps = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / (ERASER_RADIUS / 2)));
    for (let i = 1; i <= steps; i++) this.erase(lx + ((x - lx) * i) / steps, ly + ((y - ly) * i) / steps);
    this.last = [x, y];
  }

  private erase(x: number, y: number) {
    for (const s of this.strokes) {
      if (s.el.isConnected && hits(s, x, y, ERASER_RADIUS)) {
        s.el.remove();
        this.erased!.push(s);
      }
    }
  }

  private commit(change: Change) {
    this.apply(change.added, change.removed);
    this.undos.push(change);
    this.redos = [];
    this.onChange();
  }

  private apply(added: Stroke[], removed: Stroke[]) {
    const gone = new Set(removed);
    this.strokes = this.strokes.filter((s) => !gone.has(s));
    for (const s of removed) s.el.remove();
    for (const s of added) {
      this.layer.append(s.el);
      this.strokes.push(s);
    }
    // Keep at least half a screen of empty page below the writing.
    if (this.bottom() + this.screenHeight() / 2 > this.height) this.layout();
  }

  private bottom() {
    return this.strokes.reduce((max, s) => Math.max(max, s.box[3]), 0);
  }

  /** Visible height in page units. */
  private screenHeight() {
    const width = this.svg.getBoundingClientRect().width;
    return width ? (this.el.clientHeight * PAGE_WIDTH) / width : 0;
  }

  private layout() {
    const width = this.svg.getBoundingClientRect().width;
    if (!width) return; // hidden
    const screen = this.screenHeight();
    this.height = Math.max(screen, this.bottom() + screen * 0.75);
    this.svg.setAttribute('viewBox', `0 0 ${PAGE_WIDTH} ${this.height}`);
    this.svg.style.height = `${(this.height * width) / PAGE_WIDTH}px`;
  }
}

function outline(points: Point[], pen: boolean, last: boolean): string {
  const pts = getStroke(points, { ...STROKE, simulatePressure: !pen, last });
  if (pts.length < 4) return '';
  // Smooth closed outline: quadratic curves through the midpoints of the outline points.
  const f = (n: number) => +n.toFixed(1);
  const mid = (a: number[], b: number[]) => `${f((a[0] + b[0]) / 2)},${f((a[1] + b[1]) / 2)}`;
  let d = `M${f(pts[0][0])},${f(pts[0][1])}Q${f(pts[1][0])},${f(pts[1][1])} ${mid(pts[1], pts[2])}T`;
  for (let i = 2; i < pts.length - 1; i++) d += mid(pts[i], pts[i + 1]) + ' ';
  return d.trimEnd() + 'Z';
}

function toStroke(color: string, d: string): Stroke {
  const el = document.createElementNS(NS, 'path');
  el.setAttribute('fill', color);
  el.setAttribute('d', d);
  const poly = (d.match(NUMBER) ?? []).map(Number);
  const box: Stroke['box'] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < poly.length; i += 2) {
    box[0] = Math.min(box[0], poly[i]);
    box[1] = Math.min(box[1], poly[i + 1]);
    box[2] = Math.max(box[2], poly[i]);
    box[3] = Math.max(box[3], poly[i + 1]);
  }
  return { el, color, d, poly, box };
}

/** Is (x, y) inside the stroke or within r of its edge? */
function hits({ poly, box }: Stroke, x: number, y: number, r: number): boolean {
  if (x < box[0] - r || x > box[2] + r || y < box[1] - r || y > box[3] + r) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const [xi, yi, xj, yj] = [poly[i], poly[i + 1], poly[j], poly[j + 1]];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    if (segmentDistance2(x, y, xi, yi, xj, yj) <= r * r) return true;
  }
  return inside;
}

function segmentDistance2(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}
