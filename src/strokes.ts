import { getStroke, type StrokeOptions } from 'perfect-freehand';

/** Page width in page units. The page scales to fit the screen, so a note looks the same on every device. */
export const PAGE_WIDTH = 1000;
export const LINE_GAP = 40;
/** Gap between the pages of a PDF, in page units. */
export const PDF_GAP = 24;
/** Opacity of highlighter ink. */
export const HIGHLIGHT = 0.4;
export const BLACK = '#1a1a1a';

export type Point = [x: number, y: number, pressure: number];
export type Box = [x0: number, y0: number, x1: number, y1: number];
export type Brush = 'fountain' | 'ballpoint' | 'highlighter';
export type Paper = 'lined' | 'grid' | 'dotted' | 'blank';
export const PAPERS: Paper[] = ['lined', 'grid', 'dotted', 'blank'];

export interface Stroke {
  type: 'stroke';
  color: string;
  /** Below 1 for highlighter, which is drawn under the ink. */
  opacity: number;
  /** The filled outline, as SVG path data in page units. */
  d: string;
  /** Outline polygon as flat x,y pairs, for hit tests. */
  poly: number[];
  box: Box;
}

/** A photo or screenshot on the page. */
export interface Picture {
  type: 'picture';
  /** The image file, in attachments/. */
  src: string;
  box: Box;
}

export type Item = Stroke | Picture;

/** Everything a handwritten note holds. */
export interface Page {
  paper: Paper;
  /** A PDF the note is written on, in attachments/. Its pages are stacked at the top of the page. */
  pdf: string | null;
  items: Item[];
}

const BRUSHES: Record<Brush, StrokeOptions> = {
  // Width follows pressure.
  fountain: { thinning: 0.5, smoothing: 0.6, streamline: 0.45 },
  ballpoint: { thinning: 0, smoothing: 0.6, streamline: 0.45 },
  // Flat ends, and steadier than a pen.
  highlighter: { thinning: 0, smoothing: 0.7, streamline: 0.6, start: { cap: false }, end: { cap: false } },
};

const NUMBER = /-?\d+(?:\.\d+)?/g;
const SAFE_PATH = /^[MQTZ\d\s.,-]+$/;
const SAFE_COLOR = /^#[0-9a-f]{3,8}$/i;
const SAFE_IMAGE = /^attachments\/[\w-]+\.(png|jpe?g|webp|gif)$/i;
const SAFE_PDF = /^attachments\/[\w-]+\.pdf$/i;
const round = (n: number) => +n.toFixed(2);

/**
 * The outline of a stroke through `points`, as SVG path data. `pressure` says whether the points carry real pen
 * pressure; `exact` draws a clean shape at an even width, without smoothing away its corners.
 */
export function outline(points: Point[], brush: Brush, size: number, { pressure = false, last = true, exact = false } = {}) {
  const options: StrokeOptions = exact
    ? { ...BRUSHES[brush], size, thinning: 0, smoothing: 0.5, streamline: 0, last: true }
    : { ...BRUSHES[brush], size, simulatePressure: !pressure, last };
  const pts = getStroke(points, options);
  if (pts.length < 4) return '';
  // Smooth closed outline: quadratic curves through the midpoints of the outline points.
  const mid = (a: number[], b: number[]) => `${round((a[0] + b[0]) / 2)},${round((a[1] + b[1]) / 2)}`;
  let d = `M${round(pts[0][0])},${round(pts[0][1])}Q${round(pts[1][0])},${round(pts[1][1])} ${mid(pts[1], pts[2])}T`;
  for (let i = 2; i < pts.length - 1; i++) d += mid(pts[i], pts[i + 1]) + ' ';
  return d.trimEnd() + 'Z';
}

export function makeStroke(color: string, d: string, opacity = 1): Stroke {
  const poly = (d.match(NUMBER) ?? []).map(Number);
  return { type: 'stroke', color, opacity, d, poly, box: boxOf(poly) };
}

export const picture = (src: string, box: Box): Picture => ({ type: 'picture', src, box: box.map(round) as Box });

/** The item scaled by k, then moved by (tx, ty). Every number in a stroke's path is an absolute x or y, in turn. */
export function transformed(item: Item, k: number, tx: number, ty: number): Item {
  if (item.type === 'picture') {
    const [x0, y0, x1, y1] = item.box;
    return picture(item.src, [x0 * k + tx, y0 * k + ty, x1 * k + tx, y1 * k + ty]);
  }
  let i = 0;
  const d = item.d.replace(NUMBER, (n) => String(round(+n * k + (i++ % 2 ? ty : tx))));
  return makeStroke(item.color, d, item.opacity);
}

/** Bounding box of flat x,y pairs. */
export function boxOf(poly: number[]): Box {
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < poly.length; i += 2) {
    box[0] = Math.min(box[0], poly[i]);
    box[1] = Math.min(box[1], poly[i + 1]);
    box[2] = Math.max(box[2], poly[i]);
    box[3] = Math.max(box[3], poly[i + 1]);
  }
  return box;
}

export const overlaps = (a: Box, b: Box) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

export function union(boxes: Box[]): Box {
  return boxes.reduce<Box>(
    (u, b) => [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}

/** Is (x, y) inside the polygon given as flat x,y pairs? */
export function inside(poly: number[], x: number, y: number): boolean {
  let result = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const [xi, yi, xj, yj] = [poly[i], poly[i + 1], poly[j], poly[j + 1]];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) result = !result;
  }
  return result;
}

/** Is (x, y) inside the stroke or within r of its edge? */
export function hits({ poly, box }: Stroke, x: number, y: number, r: number): boolean {
  if (x < box[0] - r || x > box[2] + r || y < box[1] - r || y > box[3] + r) return false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    if (segmentDistance2(x, y, poly[i], poly[i + 1], poly[j], poly[j + 1]) <= r * r) return true;
  }
  return inside(poly, x, y);
}

/** Is most of the item inside the lasso (flat x,y pairs)? */
export function lassoed(item: Item, lasso: number[]): boolean {
  let points = item.type === 'stroke' ? item.poly : [];
  if (item.type === 'picture') {
    const [x0, y0, x1, y1] = item.box;
    points = [x0, y0, x1, y0, x1, y1, x0, y1, (x0 + x1) / 2, (y0 + y1) / 2];
  }
  const n = points.length / 2;
  const step = Math.max(1, Math.floor(n / 24));
  let hit = 0;
  let total = 0;
  for (let i = 0; i < n; i += step, total++) if (inside(lasso, points[2 * i], points[2 * i + 1])) hit++;
  return total > 0 && hit * 2 >= total;
}

/** Squared distance from p to the segment ab. */
export function segmentDistance2(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

/** Where each page of a PDF goes: full width, stacked top to bottom. `sizes` are each page's width and height. */
export function layoutPdf(sizes: [width: number, height: number][]): { top: number; height: number }[] {
  let top = 0;
  return sizes.map(([w, h]) => {
    const page = { top, height: (PAGE_WIDTH * h) / w };
    top += page.height + PDF_GAP;
    return page;
  });
}

const RULE = 'stroke="#e6ebf2"';
const PATTERNS: Record<Paper, string> = {
  lined: `<line x1="0" y1="39.5" x2="40" y2="39.5" ${RULE}/>`,
  grid: `<line x1="0" y1="39.5" x2="40" y2="39.5" ${RULE}/><line x1="39.5" y1="0" x2="39.5" y2="40" ${RULE}/>`,
  dotted: '<circle cx="20" cy="20" r="1.5" fill="#c5ccd6"/>',
  blank: '',
};

/**
 * A plain SVG that also shows on GitHub: paper, then photos, then highlighter, then ink, as on screen.
 * Photos and PDFs are files of their own in attachments/, so GitHub's preview leaves them out.
 */
export function toSvg({ paper, pdf, items }: Page, height: number): string {
  const pictures = items.filter((i) => i.type === 'picture');
  const strokes = items.filter((i) => i.type === 'stroke');
  const ordered = [...strokes.filter((s) => s.opacity < 1), ...strokes.filter((s) => s.opacity >= 1)];
  // Dots sit where grid lines would cross, so the dotted pattern is shifted by half a square.
  const pattern = PATTERNS[paper]
    ? `<defs><pattern id="paper"${paper === 'dotted' ? ' x="-20" y="-20"' : ''} width="${LINE_GAP}" height="${LINE_GAP}" patternUnits="userSpaceOnUse">${PATTERNS[paper]}</pattern></defs>\n` +
      `<rect width="100%" height="100%" fill="url(#paper)"/>\n`
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${height}" viewBox="0 0 ${PAGE_WIDTH} ${height}" data-paper="${paper}"${pdf ? ` data-pdf="${pdf}"` : ''}>\n` +
    `<rect width="100%" height="100%" fill="#fff"/>\n${pattern}` +
    pictures
      .map(({ src, box: [x0, y0, x1, y1] }) => {
        return `<image href="${src}" x="${x0}" y="${y0}" width="${round(x1 - x0)}" height="${round(y1 - y0)}" preserveAspectRatio="none"/>\n`;
      })
      .join('') +
    ordered.map((s) => `<path fill="${s.color}"${s.opacity < 1 ? ` fill-opacity="${s.opacity}"` : ''} d="${s.d}"/>\n`).join('') +
    '</svg>\n'
  );
}

const ATTRIBUTE = /([\w:-]+)="([^"]*)"/g;
const attributes = (tag: string) => new Map([...tag.matchAll(ATTRIBUTE)].map(([, name, value]) => [name, value]));

/** Reads a saved note back, skipping anything this app didn't put there. */
export function fromSvg(svg: string): Page {
  const root = attributes(svg.match(/<svg\b([^>]*)>/)?.[1] ?? '');
  const paper = root.get('data-paper') as Paper;
  const pdf = root.get('data-pdf') ?? '';
  const items: Item[] = [];
  for (const [, tag] of svg.matchAll(/<image\b([^>]*)>/g)) {
    const a = attributes(tag);
    const src = a.get('href') ?? a.get('xlink:href') ?? '';
    const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((name) => Number(a.get(name) ?? 0));
    if (SAFE_IMAGE.test(src) && [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) items.push(picture(src, [x, y, x + w, y + h]));
  }
  for (const [, tag] of svg.matchAll(/<path\b([^>]*)>/g)) {
    const a = attributes(tag);
    const d = a.get('d') ?? '';
    if (!SAFE_PATH.test(d)) continue;
    const fill = a.get('fill') ?? '';
    const opacity = Number(a.get('fill-opacity') ?? 1);
    items.push(makeStroke(SAFE_COLOR.test(fill) ? fill : BLACK, d, opacity > 0 && opacity <= 1 ? opacity : 1));
  }
  // Notes from before paper styles were all lined.
  return { paper: PAPERS.includes(paper) ? paper : 'lined', pdf: SAFE_PDF.test(pdf) ? pdf : null, items };
}

/** The photos and PDF a saved note uses. */
export const attachmentsIn = (svg: string) => [...new Set(svg.match(/attachments\/[\w-]+\.\w+/g) ?? [])];
