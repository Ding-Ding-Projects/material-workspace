/**
 * PowerPoint presentations, read and written.
 *
 * FIVE THINGS ABOUT THIS FORMAT THAT A NAIVE READER GETS WRONG, and each one
 * produces a file that opens without complaint and is subtly, silently wrong.
 *
 *   - EMU, NOT POINTS. Positions and sizes are English Metric Units: 914400 to
 *     the inch, 12700 to the point. A reader that treats them as points places
 *     every shape 12700 times too far from the origin, which reads as an empty
 *     slide because everything is off the canvas.
 *
 *   - THE SLIDE ORDER IS NOT THE FILE ORDER. `ppt/slides/slide1.xml` is a name,
 *     not a position. The order lives in `presentation.xml` as a list of
 *     relationship ids, and sorting the parts by filename puts slide10 between
 *     slide1 and slide2.
 *
 *   - A TITLE IS A PLACEHOLDER, NOT THE FIRST SHAPE. `<p:ph type="title"/>` is
 *     what makes a shape the title. Taking the topmost or first shape gets the
 *     right answer often enough to look correct and wrong whenever somebody
 *     moved something.
 *
 *   - TEXT IS PARAGRAPHS OF RUNS. `<a:p>` is a paragraph and `<a:r>` a run
 *     within it. Concatenating every `<a:t>` in a shape runs the lines
 *     together, and a bulleted list becomes one long sentence.
 *
 *   - NOTES ARE A SEPARATE PART. They live in `notesSlide` parts related to the
 *     slide, and they carry the slide's own text as a placeholder too - so a
 *     reader that takes all the text from the notes part shows the slide body
 *     twice in the presenter view.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. No masters, no layouts beyond naming one,
 * no theme colours, no images, no charts, no animation. Those are read as
 * absent rather than approximated, because a shape drawn in the wrong place
 * from a half-understood theme is worse than a shape that is honestly missing.
 */

import {
  type Frame,
  type Presentation,
  type Slide,
  type SlideElement,
  type SlideSize,
  GEOMETRY,
} from '../slide/model.js';
import { type XmlElement, childElements, firstChild, parseXml, textOf } from './xml.js';
import { readZip, writeZip } from './zip.js';

export class PptxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PptxError';
  }
}

/** English Metric Units to the inch, and to the point. */
const EMU_PER_INCH = 914400;
const EMU_PER_POINT = 12700;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/* -------------------------------------------------------------- reading -- */

export async function readPptx(bytes: Uint8Array): Promise<Presentation> {
  const parts = await readZip(bytes);

  const presentationPart = parts.get('ppt/presentation.xml');
  if (presentationPart === undefined) {
    throw new PptxError('this file has no ppt/presentation.xml, so it is not a presentation');
  }

  const presentationXml = parseXml(decoder.decode(presentationPart));
  const size = readSize(presentationXml);

  // The ORDER comes from presentation.xml, not from the file names. Sorting
  // parts by name puts slide10 between slide1 and slide2, which is the wrong
  // order in a way nobody notices until a deck has ten slides.
  const relationships = readRelationships(parts, 'ppt/_rels/presentation.xml.rels');
  const idList = firstChild(presentationXml, 'p:sldIdLst');
  const order: string[] = [];
  if (idList !== undefined) {
    for (const entry of childElements(idList, 'p:sldId')) {
      const relationshipId = entry.attributes.get('r:id');
      if (relationshipId === undefined) continue;
      const target = relationships.get(relationshipId);
      if (target !== undefined) order.push(resolve('ppt', target));
    }
  }

  if (order.length === 0) {
    throw new PptxError('the presentation lists no slides');
  }

  const slides: Slide[] = [];
  for (const [index, partName] of order.entries()) {
    const slidePart = parts.get(partName);
    if (slidePart === undefined) {
      // Named in the order and absent from the package. Skipped and not
      // invented: a blank slide inserted here would silently change the
      // numbering of every slide after it.
      continue;
    }
    slides.push(readSlide(parseXml(decoder.decode(slidePart)), partName, parts, index, size));
  }

  return { schema: 'material-workspace/slides@1', size, slides };
}

function readSize(presentationXml: XmlElement): SlideSize {
  const size = firstChild(presentationXml, 'p:sldSz');
  const width = Number(size?.attributes.get('cx') ?? 0);
  const height = Number(size?.attributes.get('cy') ?? 0);
  if (width <= 0 || height <= 0) return '16:9';
  // Compared as a ratio rather than against exact EMU values: a deck authored
  // at an unusual size is still one shape or the other, and refusing it would
  // be refusing a file that opens fine everywhere else.
  return width / height > 1.5 ? '16:9' : '4:3';
}

function readSlide(
  slideXml: XmlElement,
  partName: string,
  parts: ReadonlyMap<string, Uint8Array>,
  index: number,
  size: SlideSize,
): Slide {
  const tree = firstChild(slideXml, 'p:cSld');
  const shapeTree = tree === undefined ? undefined : firstChild(tree, 'p:spTree');

  const elements: SlideElement[] = [];
  let sawTitle = false;

  if (shapeTree !== undefined) {
    for (const shape of childElements(shapeTree, 'p:sp')) {
      const element = readShape(shape, size, elements.length, index);
      if (element === null) continue;
      if (element.kind === 'text' && element.role === 'title') sawTitle = true;
      elements.push(element);
    }
  }

  return {
    id: 's' + (index + 1),
    // The layout is named from what the slide actually contains rather than
    // read from the layout part. Reading the part would give a name from
    // PowerPoint's own vocabulary that means nothing here.
    layout: sawTitle ? (elements.length > 1 ? 'titleAndContent' : 'title') : 'blank',
    elements,
    notes: readNotes(partName, parts),
    advanceAfter: 0,
    transition: 'none',
    hidden: slideXml.attributes.get('show') === '0',
  };
}

function readShape(
  shape: XmlElement,
  size: SlideSize,
  ordinal: number,
  slideIndex: number,
): SlideElement | null {
  const body = firstChild(shape, 'p:txBody');
  if (body === undefined) return null;

  // Paragraph by paragraph, joined with newlines. Concatenating every <a:t>
  // in the shape runs a bulleted list into one long sentence.
  const paragraphs: string[] = [];
  for (const paragraph of childElements(body, 'a:p')) {
    let line = '';
    for (const run of childElements(paragraph, 'a:r')) {
      const text = firstChild(run, 'a:t');
      if (text !== undefined) line += textOf(text);
    }
    // A <a:br/> inside a paragraph is a line break, and an empty paragraph is
    // a blank line somebody typed deliberately.
    paragraphs.push(line);
  }
  const text = paragraphs.join('\n');

  const role = placeholderRole(shape);
  const style = readStyle(body);

  return {
    kind: 'text',
    id: 'e' + (slideIndex + 1) + '-' + (ordinal + 1),
    frame: readFrame(shape, size),
    text,
    style,
    ...(role === null ? {} : { role }),
  };
}

/**
 * The title is whatever declares itself the title.
 *
 * `<p:ph type="title"/>` or `type="ctrTitle"`. Taking the first or topmost
 * shape instead is right often enough to look correct, and wrong the moment
 * somebody reorders or moves something.
 */
function placeholderRole(shape: XmlElement): 'title' | 'subtitle' | 'body' | null {
  const properties = firstChild(shape, 'p:nvSpPr');
  const nonVisual = properties === undefined ? undefined : firstChild(properties, 'p:nvPr');
  const placeholder = nonVisual === undefined ? undefined : firstChild(nonVisual, 'p:ph');
  const type = placeholder?.attributes.get('type');
  if (type === 'title' || type === 'ctrTitle') return 'title';
  if (type === 'subTitle') return 'subtitle';
  if (placeholder !== undefined) return 'body';
  return null;
}

function readFrame(shape: XmlElement, size: SlideSize): Frame {
  const properties = firstChild(shape, 'p:spPr');
  const transform = properties === undefined ? undefined : firstChild(properties, 'a:xfrm');
  const offset = transform === undefined ? undefined : firstChild(transform, 'a:off');
  const extent = transform === undefined ? undefined : firstChild(transform, 'a:ext');

  const geometry = GEOMETRY[size];
  // EMU to points, then points to the 0..1 slide space this model uses.
  // Treating EMU as points puts every shape 12700 times too far out, which
  // presents as a blank slide rather than as a misplaced one.
  const slideWidthEmu = geometry.width * EMU_PER_POINT;
  const slideHeightEmu = geometry.height * EMU_PER_POINT;

  const x = Number(offset?.attributes.get('x') ?? 0) / slideWidthEmu;
  const y = Number(offset?.attributes.get('y') ?? 0) / slideHeightEmu;
  const width = Number(extent?.attributes.get('cx') ?? 0) / slideWidthEmu;
  const height = Number(extent?.attributes.get('cy') ?? 0) / slideHeightEmu;

  // A shape with no transform inherits it from the layout, which is not read.
  // A sensible default beats a zero-sized shape nobody can see or select.
  if (width <= 0 || height <= 0) {
    return { x: 0.08, y: 0.1, width: 0.84, height: 0.2 };
  }
  return { x: clamp(x), y: clamp(y), width: clamp(width), height: clamp(height) };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function readStyle(body: XmlElement): { size?: number; bold?: boolean; italic?: boolean } {
  // The first run's properties. A per-run style model would be more faithful
  // and this model holds one style per text element, so the first run is the
  // honest approximation rather than a merged average of all of them.
  const paragraph = firstChild(body, 'a:p');
  const run = paragraph === undefined ? undefined : firstChild(paragraph, 'a:r');
  const properties = run === undefined ? undefined : firstChild(run, 'a:rPr');
  if (properties === undefined) return {};

  const style: { size?: number; bold?: boolean; italic?: boolean } = {};
  const hundredths = Number(properties.attributes.get('sz') ?? 0);
  // `sz` is in HUNDREDTHS of a point. Read as points it produces 1800pt text.
  if (hundredths > 0) style.size = hundredths / 100;
  if (properties.attributes.get('b') === '1') style.bold = true;
  if (properties.attributes.get('i') === '1') style.italic = true;
  return style;
}

/**
 * Speaker notes, from the notes part related to this slide.
 *
 * The notes part carries the SLIDE's text too, in a placeholder, so taking
 * every `<a:t>` in it shows the slide body again in the presenter view. Only
 * the body placeholder is read.
 */
function readNotes(slidePart: string, parts: ReadonlyMap<string, Uint8Array>): string {
  const directory = slidePart.slice(0, slidePart.lastIndexOf('/'));
  const name = slidePart.slice(slidePart.lastIndexOf('/') + 1);
  const relationships = readRelationships(parts, directory + '/_rels/' + name + '.rels');

  let notesPart: string | undefined;
  for (const target of relationships.values()) {
    if (target.includes('notesSlide')) {
      notesPart = resolve(directory, target);
      break;
    }
  }
  if (notesPart === undefined) return '';

  const bytes = parts.get(notesPart);
  if (bytes === undefined) return '';

  const xml = parseXml(decoder.decode(bytes));
  const tree = firstChild(xml, 'p:cSld');
  const shapeTree = tree === undefined ? undefined : firstChild(tree, 'p:spTree');
  if (shapeTree === undefined) return '';

  for (const shape of childElements(shapeTree, 'p:sp')) {
    const properties = firstChild(shape, 'p:nvSpPr');
    const nonVisual = properties === undefined ? undefined : firstChild(properties, 'p:nvPr');
    const placeholder = nonVisual === undefined ? undefined : firstChild(nonVisual, 'p:ph');
    if (placeholder?.attributes.get('type') !== 'body') continue;

    const body = firstChild(shape, 'p:txBody');
    if (body === undefined) continue;

    const lines: string[] = [];
    for (const paragraph of childElements(body, 'a:p')) {
      let line = '';
      for (const run of childElements(paragraph, 'a:r')) {
        const text = firstChild(run, 'a:t');
        if (text !== undefined) line += textOf(text);
      }
      lines.push(line);
    }
    return lines.join('\n');
  }
  return '';
}

/* ------------------------------------------------------------- plumbing -- */

function readRelationships(
  parts: ReadonlyMap<string, Uint8Array>,
  name: string,
): Map<string, string> {
  const found = new Map<string, string>();
  const bytes = parts.get(name);
  if (bytes === undefined) return found;

  const xml = parseXml(decoder.decode(bytes));
  for (const relationship of childElements(xml, 'Relationship')) {
    const id = relationship.attributes.get('Id');
    const target = relationship.attributes.get('Target');
    if (id !== undefined && target !== undefined) found.set(id, target);
  }
  return found;
}

/** Resolve a relationship target against the part that declared it. */
function resolve(directory: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const segments = (directory + '/' + target).split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

/* -------------------------------------------------------------- writing -- */

/**
 * Write a presentation as a .pptx.
 *
 * Everything this cannot represent is simply absent rather than approximated -
 * see the note at the top. What it writes, it writes correctly: EMU, an
 * explicit slide order, and title placeholders that other applications will
 * recognise as titles.
 */
export function writePptx(presentation: Presentation): Uint8Array {
  const geometry = GEOMETRY[presentation.size];
  const slides = presentation.slides;

  const parts: { name: string; data: Uint8Array }[] = [];
  const add = (name: string, xml: string): void => {
    parts.push({ name, data: encoder.encode(xml) });
  };

  add(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      slides
        .map(
          (_slide, index) =>
            '<Override PartName="/ppt/slides/slide' + (index + 1) + '.xml" ' +
            'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
        )
        .join('') +
      slides
        .map((slide, index) =>
          slide.notes === ''
            ? ''
            : '<Override PartName="/ppt/notesSlides/notesSlide' + (index + 1) + '.xml" ' +
              'ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>',
        )
        .join('') +
      '</Types>',
  );

  add(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
      '</Relationships>',
  );

  add(
    'ppt/presentation.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<p:sldIdLst>' +
      slides
        .map((_slide, index) => '<p:sldId id="' + (256 + index) + '" r:id="rId' + (index + 1) + '"/>')
        .join('') +
      '</p:sldIdLst>' +
      '<p:sldSz cx="' + geometry.width * EMU_PER_POINT + '" cy="' + geometry.height * EMU_PER_POINT + '"/>' +
      '</p:presentation>',
  );

  add(
    'ppt/_rels/presentation.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      slides
        .map(
          (_slide, index) =>
            '<Relationship Id="rId' + (index + 1) + '" ' +
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" ' +
            'Target="slides/slide' + (index + 1) + '.xml"/>',
        )
        .join('') +
      '</Relationships>',
  );

  slides.forEach((slide, index) => {
    add('ppt/slides/slide' + (index + 1) + '.xml', slideXml(slide, geometry));

    if (slide.notes !== '') {
      add(
        'ppt/slides/_rels/slide' + (index + 1) + '.xml.rels',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" ' +
          'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" ' +
          'Target="../notesSlides/notesSlide' + (index + 1) + '.xml"/>' +
          '</Relationships>',
      );
      add('ppt/notesSlides/notesSlide' + (index + 1) + '.xml', notesXml(slide.notes));
    }
  });

  return writeZip(parts);
}

function slideXml(slide: Slide, geometry: { width: number; height: number }): string {
  const shapes = slide.elements
    .filter((element): element is Extract<SlideElement, { kind: 'text' }> => element.kind === 'text')
    .map((element, ordinal) => {
      const x = Math.round(element.frame.x * geometry.width * EMU_PER_POINT);
      const y = Math.round(element.frame.y * geometry.height * EMU_PER_POINT);
      const cx = Math.round(element.frame.width * geometry.width * EMU_PER_POINT);
      const cy = Math.round(element.frame.height * geometry.height * EMU_PER_POINT);

      const placeholder =
        element.role === 'title'
          ? '<p:ph type="title"/>'
          : element.role === 'subtitle'
            ? '<p:ph type="subTitle"/>'
            : '<p:ph type="body" idx="' + (ordinal + 1) + '"/>';

      const runProperties =
        '<a:rPr lang="en"' +
        (element.style.size === undefined
          ? ''
          : ' sz="' + Math.round(element.style.size * 100) + '"') +
        (element.style.bold === true ? ' b="1"' : '') +
        (element.style.italic === true ? ' i="1"' : '') +
        '/>';

      // One <a:p> per line. Writing the whole text in one paragraph turns a
      // list back into a sentence on the next read.
      const body = element.text
        .split('\n')
        .map(
          (line) =>
            '<a:p><a:r>' + runProperties + '<a:t>' + escapeXml(line) + '</a:t></a:r></a:p>',
        )
        .join('');

      return (
        '<p:sp>' +
        '<p:nvSpPr>' +
        '<p:cNvPr id="' + (ordinal + 2) + '" name="' + escapeXml(element.role ?? 'Text') + '"/>' +
        '<p:cNvSpPr txBox="1"/>' +
        '<p:nvPr>' + placeholder + '</p:nvPr>' +
        '</p:nvSpPr>' +
        '<p:spPr><a:xfrm>' +
        '<a:off x="' + x + '" y="' + y + '"/>' +
        '<a:ext cx="' + cx + '" cy="' + cy + '"/>' +
        '</a:xfrm></p:spPr>' +
        '<p:txBody><a:bodyPr/><a:lstStyle/>' + body + '</p:txBody>' +
        '</p:sp>'
      );
    })
    .join('');

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
    (slide.hidden ? ' show="0"' : '') +
    '><p:cSld><p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr/>' +
    shapes +
    '</p:spTree></p:cSld></p:sld>'
  );
}

function notesXml(notes: string): string {
  const body = notes
    .split('\n')
    .map((line) => '<a:p><a:r><a:t>' + escapeXml(line) + '</a:t></a:r></a:p>')
    .join('');

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<p:cSld><p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr/>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr txBox="1"/>' +
    '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
    '<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>' + body + '</p:txBody></p:sp>' +
    '</p:spTree></p:cSld></p:notes>'
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
