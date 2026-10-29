import { PDFDocument, degrees } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { exportPdf, pageBreak, pathOps } from './export';
import {
  BLACK,
  HIGHLIGHT,
  PDF_GAP,
  attachmentsIn,
  fromSvg,
  lassoed,
  layoutPdf,
  makeStroke,
  outline,
  picture,
  toSvg,
  transformed,
  type Page,
  type Stroke,
} from './strokes';

const line = Array.from({ length: 30 }, (_, i): [number, number, number] => [100 + i * 5, 200 + i, 0.5]);
const strokes = (page: Page) => page.items.filter((i): i is Stroke => i.type === 'stroke');

describe('saved notes', () => {
  it('save and load, with highlighter under the ink', () => {
    const pen = makeStroke(BLACK, outline(line, 'fountain', 4.5));
    const marker = makeStroke('#facc15', outline(line, 'highlighter', 24), HIGHLIGHT);
    const svg = toSvg({ paper: 'lined', pdf: null, items: [pen, marker] }, 300);
    expect(svg.indexOf('fill-opacity="0.4"')).toBeLessThan(svg.indexOf(`fill="${BLACK}"`));
    const loaded = fromSvg(svg);
    expect(strokes(loaded).map((s) => [s.color, s.opacity, s.d])).toEqual([
      ['#facc15', HIGHLIGHT, marker.d],
      [BLACK, 1, pen.d],
    ]);
    expect(toSvg(loaded, 300)).toBe(svg);
  });

  it('keep paper, photos and the PDF they are written on', () => {
    const page: Page = {
      paper: 'dotted',
      pdf: 'attachments/0123456789abcdef.pdf',
      items: [picture('attachments/fedcba9876543210.jpg', [100, 120.5, 400, 320.25]), makeStroke(BLACK, 'M1,2Q3,4 5,6T7,8Z')],
    };
    const svg = toSvg(page, 500);
    expect(fromSvg(svg)).toEqual(page);
    expect(svg).toContain('<pattern id="paper" x="-20" y="-20"');
    expect(attachmentsIn(svg).sort()).toEqual(['attachments/0123456789abcdef.pdf', 'attachments/fedcba9876543210.jpg']);
  });

  it('load notes from before paper styles, highlighters and photos as lined', () => {
    const old = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#fff"/>\n<path fill="#2563eb" d="M1,2Q3,4 5,6T7,8Z"/>\n</svg>';
    const page = fromSvg(old);
    expect(page.paper).toBe('lined');
    expect(page.pdf).toBeNull();
    expect(strokes(page).map((s) => [s.color, s.opacity])).toEqual([['#2563eb', 1]]);
  });

  it('skip anything this app did not put there', () => {
    const svg =
      '<svg data-pdf="../secret.pdf"><path fill="red" d="M1,2 L3,4"/><path fill="url(#x)" d="M1,2Q3,4 5,6Z"/>' +
      '<image href="https://example.com/x.png" x="0" y="0" width="5" height="5"/><image href="attachments/a.png" x="0" y="0" width="0" height="5"/></svg>';
    const page = fromSvg(svg);
    expect(page.pdf).toBeNull();
    expect(page.items.map((i) => (i.type === 'stroke' ? i.color : i.src))).toEqual([BLACK]);
  });
});

describe('editing', () => {
  it('moves and resizes strokes and photos', () => {
    const s = makeStroke(BLACK, 'M10,20Q30,40 50,60T70,80Z');
    expect(transformed(s, 2, 5, -5)).toMatchObject({ d: 'M25,35Q65,75 105,115T145,155Z', box: [25, 35, 145, 155] });
    expect(transformed(picture('attachments/a.png', [10, 20, 30, 40]), 2, 5, -5).box).toEqual([25, 35, 65, 75]);
  });

  it('lassos what is mostly inside', () => {
    const s = makeStroke(BLACK, outline(line, 'ballpoint', 4.5));
    const around = [90, 190, 260, 190, 260, 240, 90, 240];
    const half = [90, 190, 150, 190, 150, 240, 90, 240];
    expect(lassoed(s, around)).toBe(true);
    expect(lassoed(s, half)).toBe(false);
    expect(lassoed(picture('attachments/a.png', [100, 195, 250, 235]), around)).toBe(true);
    expect(lassoed(picture('attachments/a.png', [100, 195, 400, 235]), half)).toBe(false);
  });
});

describe('PDF', () => {
  it('stacks pages full width, landscape and portrait alike', () => {
    expect(layoutPdf([[612, 792], [792, 612]])).toEqual([
      { top: 0, height: (1000 * 792) / 612 },
      { top: (1000 * 792) / 612 + PDF_GAP, height: (1000 * 612) / 792 },
    ]);
  });

  it('turns stroke outlines into curves', () => {
    const ops = pathOps('M0,0Q30,0 30,30T60,60Z').map(String);
    expect(ops).toEqual(['0 0 m', '20 0 30 10 30 30 c', '30 50 40 60 60 60 c', 'h']);
  });

  it('breaks pages between lines of writing', () => {
    const words = [makeStroke(BLACK, 'M0,1180Q5,1185 10,1210Z'), makeStroke(BLACK, 'M0,1100Q5,1110 10,1125Z')];
    // 1200 cuts the first stroke and 1120 the second, so the page ends on the line between them.
    expect(pageBreak(words, 1000, 1220)).toBe(1160);
  });

  it('exports a note as paper pages, broken where the writing allows', async () => {
    const items = [makeStroke(BLACK, 'M10,100Q20,120 30,140Z'), makeStroke(BLACK, 'M10,2900Q20,2920 30,2950Z')];
    const bytes = await exportPdf('Lecture', { paper: 'grid', pdf: null, items }, async () => null, [612, 792]);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getTitle()).toBe('Lecture');
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
  });

  it('exports a note written on a PDF onto its own pages, keeping their size and rotation', async () => {
    const source = await PDFDocument.create();
    source.addPage([612, 792]);
    source.addPage([612, 792]).setRotation(degrees(90));
    const pdf = 'attachments/0123456789abcdef.pdf';
    const files: Record<string, Uint8Array> = { [pdf]: await source.save() };
    // One stroke on each page, and one below the PDF that needs a page of paper.
    const items = [makeStroke(BLACK, 'M10,10Q20,20 30,30Z'), makeStroke(BLACK, 'M10,1400Q20,1420 30,1440Z'), makeStroke(BLACK, 'M10,2200Q20,2220 30,2240Z')];
    const bytes = await exportPdf('Slides', { paper: 'blank', pdf, items }, async (path) => files[path] ?? null, [612, 792]);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(1).getRotation().angle).toBe(90);
    // The paper page after the PDF matches its first page's width.
    expect(doc.getPage(2).getSize().width).toBe(612);
  });
});
