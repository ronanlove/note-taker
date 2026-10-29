import { segmentDistance2 } from './strokes';

export type XY = [x: number, y: number];

export interface Shape {
  kind: 'line' | 'ellipse' | 'polygon';
  /** Closely spaced points along the shape. Closed shapes end where they start. */
  points: XY[];
}

interface Fit {
  shape: Shape;
  /** Average distance from the drawing to the shape. */
  error: number;
}

/** Gap between generated points, in page units. */
const SPACING = 2;
/** How far, on average, a drawing may stray from a shape and still snap to it, relative to its size. */
const TOLERANCE = 0.04;

/**
 * Recognizes a stroke as a straight line, an ellipse or circle, or a polygon such as a triangle or box.
 * Returns null when it's none of those, so the stroke stays as drawn.
 */
export function recognize(points: XY[]): Shape | null {
  if (points.length < 2) return null;
  const [x0, y0, x1, y1] = bounds(points);
  const size = Math.hypot(x1 - x0, y1 - y0);
  if (size < 10) return null;
  const a = points[0];
  const b = points[points.length - 1];
  const length = pathLength(points);
  const gap = distance(a, b);
  if (gap > length / 4) {
    // Open: only a straight line counts.
    const stray = Math.max(...points.map((p) => Math.sqrt(segmentDistance2(...p, ...a, ...b))));
    return stray < Math.max(2, gap * 0.05) ? line(a, b) : null;
  }
  // Closed: whichever fits better, an ellipse or a polygon.
  const loop = resample(points, length / 64);
  const fits = [ellipse(loop), polygon(loop, size)].filter((f): f is Fit => f !== null);
  const best = fits.sort((p, q) => p.error - q.error)[0];
  return best && best.error < TOLERANCE * size ? best.shape : null;
}

export function line(a: XY, b: XY): Shape {
  return { kind: 'line', points: densify([a, b]) };
}

function ellipse(loop: XY[]): Fit | null {
  const n = loop.length;
  const mx = loop.reduce((sum, p) => sum + p[0], 0) / n;
  const my = loop.reduce((sum, p) => sum + p[1], 0) / n;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const [x, y] of loop) {
    xx += (x - mx) ** 2;
    yy += (y - my) ** 2;
    xy += (x - mx) * (y - my);
  }
  // The axes run along the drawing's principal directions, level if they nearly are.
  let angle = Math.atan2(2 * xy, xx - yy) / 2;
  const level = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
  if (Math.abs(angle - level) < 0.15) angle = level;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // The size and center come from how far the drawing reaches along each axis.
  const us = loop.map(([x, y]) => (x - mx) * cos + (y - my) * sin);
  const vs = loop.map(([x, y]) => (y - my) * cos - (x - mx) * sin);
  const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
  let rx = (u1 - u0) / 2;
  let ry = (v1 - v0) / 2;
  if (Math.min(rx, ry) < 1) return null;
  const cx = mx + ((u0 + u1) / 2) * cos - ((v0 + v1) / 2) * sin;
  const cy = my + ((u0 + u1) / 2) * sin + ((v0 + v1) / 2) * cos;
  // Snap to a circle when it's close.
  if (Math.max(rx, ry) / Math.min(rx, ry) < 1.15) rx = ry = (rx + ry) / 2;

  let error = 0;
  for (const [x, y] of loop) {
    const u = (x - cx) * cos + (y - cy) * sin;
    const v = (y - cy) * cos - (x - cx) * sin;
    const r = Math.hypot(u / rx, v / ry);
    error += (Math.hypot(u, v) * Math.abs(1 - 1 / r)) / n;
  }
  const steps = Math.max(24, Math.ceil((Math.PI * (rx + ry)) / SPACING));
  const points: XY[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const u = rx * Math.cos(t);
    const v = ry * Math.sin(t);
    points.push([cx + u * cos - v * sin, cy + u * sin + v * cos]);
  }
  return { error, shape: { kind: 'ellipse', points } };
}

function polygon(loop: XY[], size: number): Fit | null {
  // The end is back near the start, so drop it.
  let corners = simplify(loop, size * 0.06).slice(0, -1);
  // Drop corners that don't really turn (such as where the drawing started, partway along a side), and tiny sides.
  for (let changed = true; changed && corners.length > 2; ) {
    changed = false;
    for (let i = 0; i < corners.length; i++) {
      const next = corners[(i + 1) % corners.length];
      if (turn(corners.at(i - 1)!, corners[i], next) < 0.5 || distance(corners[i], next) < size * 0.1) {
        corners.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  if (corners.length < 3 || corners.length > 5) return null;
  const square = (c: XY, i: number) => Math.abs(turn(corners.at(i - 1)!, c, corners[(i + 1) % 4]) - Math.PI / 2) < 0.25;
  if (corners.length === 4 && corners.every(square)) corners = rectangle(corners);

  const closed = [...corners, corners[0]];
  let error = 0;
  for (const p of loop) {
    let nearest = Infinity;
    for (let i = 1; i < closed.length; i++) nearest = Math.min(nearest, segmentDistance2(...p, ...closed[i - 1], ...closed[i]));
    error += Math.sqrt(nearest) / loop.length;
  }
  return { error, shape: { kind: 'polygon', points: densify(closed) } };
}

/** Straightens four roughly square corners into a true rectangle, level if it's nearly level. */
function rectangle(corners: XY[]): XY[] {
  // Average the side directions, folded into a quarter turn, to find how the box is rotated.
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[(i + 1) % 4];
    const a = Math.atan2(by - ay, bx - ax) * 4;
    const len = Math.hypot(bx - ax, by - ay);
    sx += Math.cos(a) * len;
    sy += Math.sin(a) * len;
  }
  let angle = Math.atan2(sy, sx) / 4;
  if (Math.abs(angle) < 0.15) angle = 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Each side sits midway between the two corners nearest it.
  const sides = (values: number[]) => {
    const s = [...values].sort((p, q) => p - q);
    return [(s[0] + s[1]) / 2, (s[2] + s[3]) / 2];
  };
  const [u0, u1] = sides(corners.map(([x, y]) => x * cos + y * sin));
  const [v0, v1] = sides(corners.map(([x, y]) => y * cos - x * sin));
  return [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ].map(([u, v]): XY => [u * cos - v * sin, u * sin + v * cos]);
}

/** Ramer–Douglas–Peucker: the fewest points that keep the line within `tolerance` of the original. */
function simplify(points: XY[], tolerance: number): XY[] {
  const a = points[0];
  const b = points[points.length - 1];
  let far = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = segmentDistance2(...points[i], ...a, ...b);
    if (d > far) {
      far = d;
      index = i;
    }
  }
  if (far <= tolerance * tolerance) return [a, b];
  return [...simplify(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplify(points.slice(index), tolerance)];
}

/** Points spaced `step` apart along the line. */
function resample(points: XY[], step: number): XY[] {
  const out: XY[] = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const len = Math.hypot(bx - ax, by - ay);
    let t = step - carry;
    for (; t <= len; t += step) out.push([ax + ((bx - ax) * t) / len, ay + ((by - ay) * t) / len]);
    carry = len - (t - step);
  }
  return out;
}

function densify(points: XY[]): XY[] {
  const out: XY[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / SPACING));
    for (let j = 1; j <= n; j++) out.push([ax + ((bx - ax) * j) / n, ay + ((by - ay) * j) / n]);
  }
  return out;
}

/** How sharply the path turns at b, in radians: 0 is straight on. */
function turn(a: XY, b: XY, c: XY) {
  const angle = Math.abs(Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]));
  return angle > Math.PI ? 2 * Math.PI - angle : angle;
}

const distance = (a: XY, b: XY) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function pathLength(points: XY[]) {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += distance(points[i - 1], points[i]);
  return length;
}

function bounds(points: XY[]) {
  return [
    Math.min(...points.map((p) => p[0])),
    Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1])),
  ];
}
