// Shows a PDF's pages under the handwriting. Only loaded when a note has a PDF, because pdf.js is large.
// The legacy build includes fallbacks for browsers a version or two old.
import { GlobalWorkerOptions, getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { PAGE_WIDTH, layoutPdf, overlaps, type Box } from './strokes';

GlobalWorkerOptions.workerSrc = workerUrl;

/** Whole pages are rendered at most this many pixels wide. Zoomed in closer, only the visible part is rendered sharp. */
const MAX_PAGE_PX = 2048;
/** Whole-page renders kept in memory, nearest the view first. */
const KEEP = 4;
/** How long the view must hold still before the sharp close-up render starts, in ms. */
const SETTLE = 150;

interface Render {
  canvas: HTMLCanvasElement;
  /** Device pixels per page unit. */
  scale: number;
  /** The part of the long page it covers, in page units. */
  box: Box;
}

export class PdfView {
  private whole = new Map<number, Render>();
  private detail = new Map<number, Render>();
  private jobs = new Map<string, () => Promise<void>>();
  private running = false;
  private settle = 0;
  /** Pages on screen at the last draw. */
  private visible: number[] = [];

  private constructor(
    private task: PDFDocumentLoadingTask,
    private doc: PDFDocumentProxy,
    /** Each page's place on the long page, in page units. */
    readonly pages: { top: number; height: number }[],
    private onReady: () => void,
  ) {}

  /** `onReady` runs whenever a newly rendered page is ready to draw. */
  static async open(bytes: Uint8Array, onReady: () => void): Promise<PdfView> {
    const task = getDocument({ data: bytes });
    const doc = await task.promise;
    const sizes: [number, number][] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const { width, height } = (await doc.getPage(i)).getViewport({ scale: 1 });
      sizes.push([width, height]);
    }
    return new PdfView(task, doc, layoutPdf(sizes), onReady);
  }

  /** Bottom of the last page, in page units. */
  get height() {
    const last = this.pages[this.pages.length - 1];
    return last ? last.top + last.height : 0;
  }

  /**
   * Draws the pages in `view` (page units). `ctx` is already set up to draw in page units, at `scale` device pixels
   * per unit. Pages not rendered yet show as blank paper and are drawn when ready.
   */
  draw(ctx: CanvasRenderingContext2D, view: Box, scale: number) {
    const want = Math.min(MAX_PAGE_PX, Math.ceil((PAGE_WIDTH * scale) / 256) * 256);
    const close = PAGE_WIDTH * scale > MAX_PAGE_PX * 1.15;
    const blurry: number[] = [];
    this.visible = [];
    this.pages.forEach(({ top, height }, i) => {
      if (!overlaps([0, top, PAGE_WIDTH, top + height], view)) return;
      this.visible.push(i);
      const whole = this.whole.get(i);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, top, PAGE_WIDTH, height);
      if (whole) ctx.drawImage(whole.canvas, 0, top, PAGE_WIDTH, height);
      if (!whole || whole.canvas.width < want * 0.8) this.schedule(`whole ${i}`, () => this.renderWhole(i, want));
      if (!close) return;
      const detail = this.detail.get(i);
      const sharp = detail && Math.abs(detail.scale / scale - 1) < 0.01;
      if (sharp) {
        const [x0, y0, x1, y1] = detail.box;
        ctx.drawImage(detail.canvas, x0, y0, x1 - x0, y1 - y0);
      }
      if (!sharp || !covers(detail.box, clip(view, [0, top, PAGE_WIDTH, top + height]))) blurry.push(i);
    });
    this.forget();
    clearTimeout(this.settle);
    if (blurry.length) {
      this.settle = window.setTimeout(() => blurry.forEach((i) => this.schedule(`detail ${i}`, () => this.renderDetail(i, view, scale))), SETTLE);
    }
  }

  destroy() {
    clearTimeout(this.settle);
    this.jobs.clear();
    for (const r of [...this.whole.values(), ...this.detail.values()]) r.canvas.width = 0;
    void this.task.destroy();
  }

  private async renderWhole(i: number, width: number) {
    // Skip pages scrolled past while waiting, and pages a render already covered.
    if (!this.near(i) || (this.whole.get(i)?.canvas.width ?? 0) >= width * 0.8) return;
    const page = await this.doc.getPage(i + 1);
    const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    const { top, height } = this.pages[i];
    this.release(this.whole.get(i));
    this.whole.set(i, { canvas, scale: width / PAGE_WIDTH, box: [0, top, PAGE_WIDTH, top + height] });
  }

  /** Renders just the visible part of a page, at full sharpness. */
  private async renderDetail(i: number, view: Box, scale: number) {
    if (!this.visible.includes(i)) return;
    const { top, height } = this.pages[i];
    const x = Math.floor(Math.max(view[0], 0) * scale);
    const y = Math.floor((Math.max(view[1], top) - top) * scale);
    const w = Math.ceil(Math.min(view[2], PAGE_WIDTH) * scale) - x;
    const h = Math.ceil((Math.min(view[3], top + height) - top) * scale) - y;
    if (w <= 0 || h <= 0) return;
    const page = await this.doc.getPage(i + 1);
    const viewport = page.getViewport({ scale: (PAGE_WIDTH * scale) / page.getViewport({ scale: 1 }).width, offsetX: -x, offsetY: -y });
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    await page.render({ canvas, viewport }).promise;
    this.release(this.detail.get(i));
    this.detail.set(i, { canvas, scale, box: [x / scale, top + y / scale, (x + w) / scale, top + (y + h) / scale] });
  }

  /** Renders one page at a time, newest request for each page winning. */
  private schedule(key: string, job: () => Promise<void>) {
    this.jobs.set(key, job);
    void this.run();
  }

  private async run() {
    if (this.running) return;
    const next = this.jobs.entries().next();
    if (next.done) return;
    const [key, job] = next.value;
    this.jobs.delete(key);
    this.running = true;
    try {
      await job();
    } catch {
      // The document was closed, or the page failed to render. It shows as blank paper.
    }
    this.running = false;
    this.onReady();
    void this.run();
  }

  /** How many pages away from the view page i is. */
  private distance(i: number) {
    return Math.min(...this.visible.map((v) => Math.abs(v - i)));
  }

  private near(i: number) {
    return this.distance(i) <= 1;
  }

  /** Lets go of renders far from the view, keeping memory in check on long PDFs. */
  private forget() {
    const far = [...this.whole.keys()].sort((a, b) => this.distance(a) - this.distance(b)).slice(KEEP);
    for (const i of far) {
      this.release(this.whole.get(i));
      this.whole.delete(i);
    }
    for (const i of this.detail.keys()) {
      if (this.visible.includes(i)) continue;
      this.release(this.detail.get(i));
      this.detail.delete(i);
    }
  }

  private release(render?: Render) {
    if (render) render.canvas.width = 0;
  }
}

const clip = (a: Box, b: Box): Box => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];

/** Does a contain b, give or take a pixel's rounding? */
const covers = (a: Box, b: Box) => a[0] <= b[0] + 0.5 && a[1] <= b[1] + 0.5 && a[2] >= b[2] - 0.5 && a[3] >= b[3] - 0.5;
