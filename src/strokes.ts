import { getStroke, type StrokeOptions } from 'perfect-freehand';

/** Page width in page units. The page scales to fit the screen, so a note looks the same on every device. */
export const PAGE_WIDTH = 1000;
export const LINE_GAP = 40;
/** Opacity of highlighter ink. */
export const HIGHLIGHT = 0.4;
export const BLACK = '#1a1a1a';

export type Point = [x: number, y: number, pressure: number];
export type Box = [x0: number, y0: number, x1: number, y1: number];
export type Brush = 'fountain' | 'ballpoint' | 'highlighter';

export interface Stroke {
  color: string;
  /** Below 1 for highlighter, which is drawn under the ink. */
  opacity: number;
  /** The filled outline, as SVG path data in page units. */
  d: string;
  /** Outline polygon as flat x,y pairs, for hit tests. */
  poly: number[];
  box: Box;
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
  return { color, opacity, d, poly, box: boxOf(poly) };
}

/** The stroke scaled by k, then moved by (tx, ty). Every number in the path is an absolute x or y, in turn. */
export function transformed(s: Stroke, k: number, tx: number, ty: number): Stroke {
  let i = 0;
  const d = s.d.replace(NUMBER, (n) => String(round(+n * k + (i++ % 2 ? ty : tx))));
  return makeStroke(s.color, d, s.opacity);
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

/** Is most of the stroke inside the lasso (flat x,y pairs)? */
export function lassoed({ poly }: Stroke, lasso: number[]): boolean {
  const n = poly.length / 2;
  const step = Math.max(1, Math.floor(n / 24));
  let hit = 0;
  let total = 0;
  for (let i = 0; i < n; i += step, total++) if (inside(lasso, poly[2 * i], poly[2 * i + 1])) hit++;
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

/** A plain SVG that also shows on GitHub. Highlighter goes first so it sits under the ink, as on screen. */
export function toSvg(strokes: Stroke[], height: number): string {
  const ordered = [...strokes.filter((s) => s.opacity < 1), ...strokes.filter((s) => s.opacity >= 1)];
  const paths = ordered
    .map((s) => `<path fill="${s.color}"${s.opacity < 1 ? ` fill-opacity="${s.opacity}"` : ''} d="${s.d}"/>\n`)
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${height}" viewBox="0 0 ${PAGE_WIDTH} ${height}">\n` +
    `<rect width="100%" height="100%" fill="#fff"/>\n${paths}</svg>\n`
  );
}

const PATH_TAG = /<path\b([^>]*)>/g;
const ATTRIBUTE = /([\w-]+)="([^"]*)"/g;

/** Reads the strokes back from a saved note, skipping anything that isn't a stroke this app drew. */
export function fromSvg(svg: string): Stroke[] {
  const strokes: Stroke[] = [];
  for (const [, attributes] of svg.matchAll(PATH_TAG)) {
    const a = new Map([...attributes.matchAll(ATTRIBUTE)].map(([, name, value]) => [name, value]));
    const d = a.get('d') ?? '';
    if (!SAFE_PATH.test(d)) continue;
    const fill = a.get('fill') ?? '';
    const opacity = Number(a.get('fill-opacity') ?? 1);
    strokes.push(makeStroke(SAFE_COLOR.test(fill) ? fill : BLACK, d, opacity > 0 && opacity <= 1 ? opacity : 1));
  }
  return strokes;
}
