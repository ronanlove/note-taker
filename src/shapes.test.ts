import { describe, expect, it } from 'vitest';
import { recognize, type XY } from './shapes';
import { BLACK, HIGHLIGHT, fromSvg, lassoed, makeStroke, outline, toSvg, transformed } from './strokes';

/** Deterministic wobble, like a hand. */
function wobbly(points: XY[], amount: number, seed = 1): XY[] {
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * amount;
  return points.map(([x, y]) => [x + rand(), y + rand()]);
}

function polyline(corners: XY[], step = 3): XY[] {
  const out: XY[] = [];
  for (let i = 1; i < corners.length; i++) {
    const [ax, ay] = corners[i - 1];
    const [bx, by] = corners[i];
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / step);
    for (let j = 0; j < n; j++) out.push([ax + ((bx - ax) * j) / n, ay + ((by - ay) * j) / n]);
  }
  out.push(corners[corners.length - 1]);
  return out;
}

function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number): XY[] {
  const out: XY[] = [];
  for (let t = from; t <= to; t += 0.05) out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  return out;
}

const area = (pts: XY[]) => Math.abs(pts.reduce((sum, [x, y], i) => sum + x * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * y, 0)) / 2;

describe('shape snapping', () => {
  it('straightens a wobbly line', () => {
    const shape = recognize(wobbly(polyline([[100, 100], [400, 180]]), 3));
    expect(shape?.kind).toBe('line');
    const [a, b] = [shape!.points[0], shape!.points.at(-1)!];
    expect(Math.hypot(a[0] - 100, a[1] - 100)).toBeLessThan(5);
    expect(Math.hypot(b[0] - 400, b[1] - 180)).toBeLessThan(5);
  });

  it('rounds a wobbly circle, even with a gap where it closes', () => {
    const shape = recognize(wobbly(arc(300, 300, 80, 80, 0.3, 2 * Math.PI - 0.1), 3));
    expect(shape?.kind).toBe('ellipse');
    for (const [x, y] of shape!.points) expect(Math.abs(Math.hypot(x - 300, y - 300) - 80)).toBeLessThan(4);
  });

  it('keeps an oval an oval', () => {
    const shape = recognize(wobbly(arc(300, 300, 150, 60, 0, 2 * Math.PI), 2));
    expect(shape?.kind).toBe('ellipse');
    expect(area(shape!.points)).toBeCloseTo(Math.PI * 150 * 60, -3);
  });

  it('squares up a box, even when drawn from partway along a side', () => {
    const shape = recognize(wobbly(polyline([[200, 100], [300, 100], [300, 220], [100, 220], [100, 100], [190, 100]]), 2.5));
    expect(shape?.kind).toBe('polygon');
    const xs = shape!.points.map((p) => p[0]);
    const ys = shape!.points.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(100, -1);
    expect(Math.max(...xs)).toBeCloseTo(300, -1);
    expect(Math.min(...ys)).toBeCloseTo(100, -1);
    expect(Math.max(...ys)).toBeCloseTo(220, -1);
    expect(area(shape!.points)).toBeCloseTo(200 * 120, -3);
  });

  it('cleans up a triangle', () => {
    const shape = recognize(wobbly(polyline([[100, 300], [200, 120], [300, 300], [100, 300]]), 2.5));
    expect(shape?.kind).toBe('polygon');
    expect(area(shape!.points)).toBeCloseTo((200 * 180) / 2, -3);
  });

  it('leaves everything else as drawn', () => {
    const wave = Array.from({ length: 120 }, (_, i): XY => [i * 3, 100 + 30 * Math.sin(i / 8)]);
    expect(recognize(wave)).toBeNull();
    expect(recognize(arc(300, 300, 80, 80, 0, Math.PI))).toBeNull();
    const star: XY[] = Array.from({ length: 11 }, (_, i) => {
      const r = i % 2 ? 40 : 100;
      return [300 + r * Math.sin((i * Math.PI) / 5), 300 - r * Math.cos((i * Math.PI) / 5)];
    });
    expect(recognize(polyline(star))).toBeNull();
    expect(recognize([[10, 10], [12, 11], [13, 13]])).toBeNull();
  });
});

describe('strokes', () => {
  const line = Array.from({ length: 30 }, (_, i): [number, number, number] => [100 + i * 5, 200 + i, 0.5]);

  it('saves and loads, with highlighter under the ink', () => {
    const pen = makeStroke(BLACK, outline(line, 'fountain', 4.5));
    const marker = makeStroke('#facc15', outline(line, 'highlighter', 24), HIGHLIGHT);
    const svg = toSvg([pen, marker], 300);
    expect(svg.indexOf('fill-opacity="0.4"')).toBeLessThan(svg.indexOf(`fill="${BLACK}"`));
    const loaded = fromSvg(svg);
    expect(loaded.map((s) => [s.color, s.opacity, s.d])).toEqual([
      ['#facc15', HIGHLIGHT, marker.d],
      [BLACK, 1, pen.d],
    ]);
    expect(toSvg(loaded, 300)).toBe(svg);
  });

  it('loads notes saved before highlighters existed', () => {
    const old = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#fff"/>\n<path fill="#2563eb" d="M1,2Q3,4 5,6T7,8Z"/>\n</svg>';
    expect(fromSvg(old).map((s) => [s.color, s.opacity])).toEqual([['#2563eb', 1]]);
  });

  it('skips anything that is not a plain stroke', () => {
    expect(fromSvg('<path fill="red" d="M1,2 L3,4"/><path fill="url(#x)" d="M1,2Q3,4 5,6Z"/>').map((s) => s.color)).toEqual([BLACK]);
  });

  it('moves and resizes', () => {
    const s = makeStroke(BLACK, 'M10,20Q30,40 50,60T70,80Z');
    expect(transformed(s, 2, 5, -5).d).toBe('M25,35Q65,75 105,115T145,155Z');
    expect(transformed(s, 2, 5, -5).box).toEqual([25, 35, 145, 155]);
  });

  it('lassos strokes that are mostly inside', () => {
    const s = makeStroke(BLACK, outline(line, 'ballpoint', 4.5));
    const around = [90, 190, 260, 190, 260, 240, 90, 240];
    const half = [90, 190, 150, 190, 150, 240, 90, 240];
    expect(lassoed(s, around)).toBe(true);
    expect(lassoed(s, half)).toBe(false);
  });
});
