// Builds a PDF of a handwritten note: vector ink that stays sharp when zoomed, photos, and, for a note written on a
// PDF, that PDF's own pages (text, links and all) with the writing on top. Only loaded when exporting.
import {
  PDFDocument,
  PDFName,
  PDFOperator,
  appendBezierCurve,
  clip,
  closePath,
  concatTransformationMatrix,
  drawObject,
  endPath,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingRgbColor,
  setGraphicsState,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';
import { LINE_GAP, PAGE_WIDTH, layoutPdf, overlaps, type Item, type Page, type Paper, type Picture } from './strokes';

type Matrix = [a: number, b: number, c: number, d: number, e: number, f: number];

/** Letter in the US and Canada, A4 elsewhere, in points. */
export const paperSize = (locale: string): [number, number] => (/-(US|CA)$/i.test(locale) ? [612, 792] : [595.28, 841.89]);

/** The PDF for a note. `size` is the paper size for notes that aren't written on a PDF. */
export async function exportPdf(
  title: string,
  { paper, pdf, items }: Page,
  file: (path: string) => Promise<Uint8Array | null>,
  size: [number, number],
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  out.setTitle(title);
  out.setCreator('Jot');
  const images = new Map<string, Promise<PDFImage | null>>();
  const bottom = items.reduce((max, i) => Math.max(max, i.box[3]), 0);
  let top = 0;

  /** Draws the items between page heights y0 and y1 onto a PDF page, through matrix m from page units. */
  const draw = async (page: PDFPage, m: Matrix, y0: number, y1: number, withPaper: boolean) => {
    const ops: PDFOperator[] = [
      pushGraphicsState(),
      concatTransformationMatrix(...m),
      concatTransformationMatrix(1, 0, 0, 1, 0, -y0),
      rectangle(0, y0, PAGE_WIDTH, y1 - y0),
      clip(),
      endPath(),
    ];
    if (withPaper) ops.push(...paperOps(paper, y0, y1));
    const here = items.filter((i) => overlaps(i.box, [0, y0, PAGE_WIDTH, y1]));
    for (const p of here.filter((i): i is Picture => i.type === 'picture')) {
      if (!images.has(p.src)) images.set(p.src, embedImage(out, p.src, file));
      const image = await images.get(p.src)!;
      if (!image) continue;
      const [x0, py0, x1, py1] = p.box;
      // Images fill a unit square with y pointing up; page units point down.
      ops.push(pushGraphicsState(), concatTransformationMatrix(x1 - x0, 0, 0, -(py1 - py0), x0, py1));
      ops.push(drawObject(page.node.newXObject('Image', image.ref)), popGraphicsState());
    }
    // Highlighter under the ink, as on screen.
    const strokes = here.filter((i) => i.type === 'stroke');
    const opacities = new Map<number, PDFName>();
    for (const s of [...strokes.filter((s) => s.opacity < 1), ...strokes.filter((s) => s.opacity >= 1)]) {
      ops.push(pushGraphicsState());
      if (s.opacity < 1) {
        if (!opacities.has(s.opacity)) opacities.set(s.opacity, page.node.newExtGState('GS', out.context.obj({ Type: 'ExtGState', ca: s.opacity })));
        ops.push(setGraphicsState(opacities.get(s.opacity)!));
      }
      ops.push(setFillingRgbColor(...rgb(s.color)), ...pathOps(s.d), fill(), popGraphicsState());
    }
    ops.push(popGraphicsState());
    page.pushOperators(...ops);
  };

  let width = size[0];
  if (pdf) {
    const bytes = await file(pdf);
    if (!bytes) throw new Error('The PDF isn’t on this device yet. Sync, then try again.');
    const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await out.copyPages(source, source.getPageIndices());
    const placed = pages.map(placement);
    const layout = layoutPdf(placed.map((p) => p.size));
    for (const [i, page] of pages.entries()) {
      out.addPage(page);
      isolate(out, page);
      await draw(page, placed[i].matrix, layout[i].top, layout[i].top + layout[i].height, false);
    }
    const last = layout[layout.length - 1];
    top = last ? last.top + last.height : 0;
    width = placed[0]?.size[0] ?? width;
  }

  // The rest of the long page, cut into paper-sized pages between lines of writing.
  const height = size[1] * (width / size[0]);
  const span = (PAGE_WIDTH * height) / width;
  const k = width / PAGE_WIDTH;
  while (top < bottom || out.getPageCount() === 0) {
    const end = top + span < bottom ? pageBreak(items, top + span * 0.75, top + span) : top + span;
    await draw(out.addPage([width, height]), [k, 0, 0, -k, 0, height], top, end, true);
    top = end;
  }
  return out.save();
}

/** Where a page ends: on a rule between y0 and y1 that cuts through the fewest strokes, as low as possible. */
export function pageBreak(items: Item[], y0: number, y1: number): number {
  let best = y1;
  let fewest = Infinity;
  for (let y = Math.floor(y1 / LINE_GAP) * LINE_GAP; y >= y0; y -= LINE_GAP) {
    const cut = items.filter((i) => i.box[1] < y && i.box[3] > y).length;
    if (cut < fewest) [best, fewest] = [y, cut];
  }
  return best;
}

/** How a PDF page shows (its size after rotation), and the matrix from page units onto it. */
function placement(page: PDFPage): { size: [number, number]; matrix: Matrix } {
  const { x, y, width, height } = page.getCropBox();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const size: [number, number] = rotation % 180 ? [height, width] : [width, height];
  const k = size[0] / PAGE_WIDTH;
  // Pages turn clockwise by `rotation` when shown; the writing has to land where it was on screen.
  const matrix: Matrix =
    rotation === 90 ? [0, k, k, 0, x, y]
    : rotation === 180 ? [-k, 0, 0, k, x + width, y]
    : rotation === 270 ? [0, -k, -k, 0, x + width, y + height]
    : [k, 0, 0, -k, x, y + height];
  return { size, matrix };
}

/** Keeps a copied page's own drawing state from leaking into the writing drawn on top of it. */
function isolate(doc: PDFDocument, page: PDFPage) {
  page.node.normalize();
  const start = doc.context.register(doc.context.contentStream([pushGraphicsState()]));
  const end = doc.context.register(doc.context.contentStream([popGraphicsState()]));
  page.node.wrapContentStreams(start, end);
}

async function embedImage(doc: PDFDocument, src: string, file: (path: string) => Promise<Uint8Array | null>) {
  const bytes = await file(src);
  if (!bytes) return null;
  if (/\.jpe?g$/i.test(src)) return doc.embedJpg(bytes);
  if (/\.png$/i.test(src)) return doc.embedPng(bytes);
  return null;
}

/** Path data from strokes (M, Q, T and Z only) as PDF operators. PDF has no quadratic curves, so they become cubic. */
export function pathOps(d: string): PDFOperator[] {
  const tokens = d.match(/[MQTZ]|-?\d+(?:\.\d+)?/g) ?? [];
  const ops: PDFOperator[] = [];
  let i = 0;
  let command = '';
  let [x, y, qx, qy] = [0, 0, 0, 0];
  const next = () => Number(tokens[i++]);
  const curve = (cx: number, cy: number, ex: number, ey: number) => {
    ops.push(appendBezierCurve(x + (2 / 3) * (cx - x), y + (2 / 3) * (cy - y), ex + (2 / 3) * (cx - ex), ey + (2 / 3) * (cy - ey), ex, ey));
    [x, y, qx, qy] = [ex, ey, cx, cy];
  };
  while (i < tokens.length) {
    if (/[MQTZ]/.test(tokens[i])) command = tokens[i++];
    if (command === 'Z') {
      ops.push(closePath());
      command = '';
    } else if (command === 'M') {
      [x, y] = [next(), next()];
      [qx, qy] = [x, y];
      ops.push(moveTo(x, y));
    } else if (command === 'Q') curve(next(), next(), next(), next());
    // T reflects the last control point through the current point.
    else if (command === 'T') curve(2 * x - qx, 2 * y - qy, next(), next());
    else i++;
  }
  return ops;
}

/** Lines, a grid or dots between page heights y0 and y1, in the light colors of real paper. */
function paperOps(paper: Paper, y0: number, y1: number): PDFOperator[] {
  if (paper === 'blank') return [];
  const ys: number[] = [];
  for (let y = Math.ceil(y0 / LINE_GAP) * LINE_GAP || LINE_GAP; y <= y1; y += LINE_GAP) ys.push(y);
  const xs = Array.from({ length: PAGE_WIDTH / LINE_GAP - 1 }, (_, i) => (i + 1) * LINE_GAP);
  if (paper === 'dotted') {
    const r = 1.5;
    const c = r * 0.5523; // Bezier circle
    const dots = ys.flatMap((cy) =>
      xs.flatMap((cx) => [
        moveTo(cx + r, cy),
        appendBezierCurve(cx + r, cy + c, cx + c, cy + r, cx, cy + r),
        appendBezierCurve(cx - c, cy + r, cx - r, cy + c, cx - r, cy),
        appendBezierCurve(cx - r, cy - c, cx - c, cy - r, cx, cy - r),
        appendBezierCurve(cx + c, cy - r, cx + r, cy - c, cx + r, cy),
      ]),
    );
    return [setFillingRgbColor(...rgb('#c5ccd6')), ...dots, fill()];
  }
  const lines = ys.flatMap((y) => [moveTo(0, y), lineTo(PAGE_WIDTH, y)]);
  if (paper === 'grid') lines.push(...xs.flatMap((x) => [moveTo(x, y0), lineTo(x, y1)]));
  return [setStrokingRgbColor(...rgb('#e6ebf2')), setLineWidth(1), ...lines, stroke()];
}

function rgb(hex: string): [number, number, number] {
  const full = hex.length === 4 ? hex.replace(/^#(.)(.)(.)$/, '#$1$1$2$2$3$3') : hex;
  return [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
}
