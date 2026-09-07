/**
 * OpenDocument presentations, read and written.
 *
 * WHERE THIS DIFFERS FROM .pptx, and each difference is a place a reader
 * written for one and pointed at the other quietly produces nonsense.
 *
 *   - CENTIMETRES AND INCHES, NOT EMU. ODF writes lengths as strings with a
 *     unit: `svg:x="2.5cm"`, `svg:width="9in"`. A reader that calls Number()
 *     on that gets NaN, and NaN placed into a layout is a shape at position
 *     zero with no size - which presents as a slide that lost its content.
 *
 *   - A SLIDE IS A <draw:page>, IN DOCUMENT ORDER. Unlike OOXML there is no
 *     separate order list, so the order really is the order. Inventing an
 *     indirection here would be inventing a bug.
 *
 *   - THE TITLE IS A PRESENTATION CLASS. `presentation:class="title"` on the
 *     frame, not the first shape and not a style name.
 *
 *   - NOTES ARE INSIDE THE PAGE. `<presentation:notes>` is a child of the
 *     slide rather than a separate part, which is the opposite of OOXML - so
 *     a reader that goes looking for a related part finds nothing and reports
 *     every slide as having no notes.
 *
 *   - TEXT IS <text:p> PER LINE, and a run of spaces is <text:s text:c="n"/>
 *     exactly as in a text document, because ODF collapses whitespace in XML.
 *
 * What it does not carry is the same list as the OOXML side: no masters, no
 * theme, no images, no animation. Absent rather than approximated.
 */

import {
  type Frame,
  type Presentation,
  type Slide,
  type SlideElement,
  type SlideSize,
  GEOMETRY,
} from '../slide/model.js';
import { type XmlElement, childElements, firstChild, parseXml } from './xml.js';
import { readZip, writeZip } from './zip.js';

export class OdpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OdpError';
  }
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * A length with its unit, in centimetres.
 *
 * ODF writes `2.5cm`, `1in`, `72pt`, `100px`. Calling Number() on any of them
 * gives NaN; NaN in a frame is a shape at the origin with no size, which looks
 * exactly like a slide whose content failed to load.
 */
export function lengthToCm(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^(-?[0-9]*\.?[0-9]+)\s*(cm|mm|in|pt|pc|px)?$/.exec(value.trim());
  if (match === null) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  switch (match[2]) {
    case 'mm':
      return amount / 10;
    case 'in':
      return amount * 2.54;
    case 'pt':
      return (amount / 72) * 2.54;
    case 'pc':
      return (amount / 6) * 2.54;
    case 'px':
      // 96 per inch, the CSS reference pixel. Not the device's own pixels,
      // which the file cannot know anything about.
      return (amount / 96) * 2.54;
    case 'cm':
    default:
      return amount;
  }
}

/* -------------------------------------------------------------- reading -- */

export async function readOdp(bytes: Uint8Array): Promise<Presentation> {
  const parts = await readZip(bytes);
  const content = parts.get('content.xml');
  if (content === undefined) {
    throw new OdpError('this file has no content.xml, so it is not an ODF package');
  }

  const xml = parseXml(decoder.decode(content));
  const body = firstChild(xml, 'office:body');
  const presentation = body === undefined ? undefined : firstChild(body, 'office:presentation');
  if (presentation === undefined) {
    throw new OdpError('this ODF file is not a presentation');
  }

  const size = readSize(parts);
  const geometry = GEOMETRY[size];
  // Points to centimetres, so a frame in cm can be normalised against it.
  const slideWidthCm = (geometry.width / 72) * 2.54;
  const slideHeightCm = (geometry.height / 72) * 2.54;

  const slides: Slide[] = [];
  // Document order IS the slide order here. There is no separate list, and
  // inventing an indirection would be inventing a bug.
  for (const [index, page] of childElements(presentation, 'draw:page').entries()) {
    slides.push(readPage(page, index, slideWidthCm, slideHeightCm));
  }

  if (slides.length === 0) throw new OdpError('the presentation has no pages');
  return { schema: 'material-workspace/slides@1', size, slides };
}

/**
 * The slide size, from the page layout in styles.xml.
 *
 * Absent is common in a fragment, and 16:9 is the honest default rather than a
 * refusal: a deck whose styles part is missing still has readable content.
 */
function readSize(parts: ReadonlyMap<string, Uint8Array>): SlideSize {
  const styles = parts.get('styles.xml');
  if (styles === undefined) return '16:9';

  const xml = parseXml(decoder.decode(styles));
  const found = findFirst(xml, 'style:page-layout-properties');
  if (found === undefined) return '16:9';

  const width = lengthToCm(found.attributes.get('fo:page-width'));
  const height = lengthToCm(found.attributes.get('fo:page-height'));
  if (width === null || height === null || height === 0) return '16:9';
  return width / height > 1.5 ? '16:9' : '4:3';
}

function findFirst(element: XmlElement, name: string): XmlElement | undefined {
  if (element.name === name) return element;
  for (const child of element.children) {
    if (typeof child === 'object' && 'name' in child) {
      const found = findFirst(child, name);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function readPage(
  page: XmlElement,
  index: number,
  slideWidthCm: number,
  slideHeightCm: number,
): Slide {
  const elements: SlideElement[] = [];
  let sawTitle = false;

  for (const frame of childElements(page, 'draw:frame')) {
    const element = readFrameElement(frame, index, elements.length, slideWidthCm, slideHeightCm);
    if (element === null) continue;
    if (element.kind === 'text' && element.role === 'title') sawTitle = true;
    elements.push(element);
  }

  return {
    id: 's' + (index + 1),
    layout: sawTitle ? (elements.length > 1 ? 'titleAndContent' : 'title') : 'blank',
    elements,
    // Inside the page, not a separate part - the opposite of OOXML. A reader
    // that goes looking for a related part reports every slide as unnoted.
    notes: readNotes(page),
    advanceAfter: 0,
    transition: 'none',
    hidden: false,
  };
}

function readFrameElement(
  frame: XmlElement,
  slideIndex: number,
  ordinal: number,
  slideWidthCm: number,
  slideHeightCm: number,
): SlideElement | null {
  const box = firstChild(frame, 'draw:text-box');
  if (box === undefined) return null;

  const lines: string[] = [];
  for (const paragraph of childElements(box, 'text:p')) lines.push(readText(paragraph));

  const role = classOf(frame);

  return {
    kind: 'text',
    id: 'e' + (slideIndex + 1) + '-' + (ordinal + 1),
    frame: readGeometry(frame, slideWidthCm, slideHeightCm),
    text: lines.join('\n'),
    style: {},
    ...(role === null ? {} : { role }),
  };
}

function classOf(frame: XmlElement): 'title' | 'subtitle' | 'body' | null {
  const value = frame.attributes.get('presentation:class');
  if (value === 'title') return 'title';
  if (value === 'subtitle') return 'subtitle';
  if (value === 'outline' || value === 'text' || value === 'notes') return 'body';
  return null;
}

function readGeometry(frame: XmlElement, slideWidthCm: number, slideHeightCm: number): Frame {
  const x = lengthToCm(frame.attributes.get('svg:x'));
  const y = lengthToCm(frame.attributes.get('svg:y'));
  const width = lengthToCm(frame.attributes.get('svg:width'));
  const height = lengthToCm(frame.attributes.get('svg:height'));

  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
    // A frame with no geometry takes its position from the layout, which is not
    // read. A sensible default beats a zero-sized shape nobody can select.
    return { x: 0.08, y: 0.1, width: 0.84, height: 0.2 };
  }

  return {
    x: clamp(x / slideWidthCm),
    y: clamp(y / slideHeightCm),
    width: clamp(width / slideWidthCm),
    height: clamp(height / slideHeightCm),
  };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Text, with ODF's space encoding expanded.
 *
 * `<text:s text:c="3"/>` is three spaces, because XML collapses whitespace and
 * ODF therefore cannot write them literally. A reader that ignores it silently
 * squashes every run of spaces the author typed.
 */
function readText(paragraph: XmlElement): string {
  let out = '';
  for (const child of paragraph.children) {
    if (typeof child === 'object' && 'text' in child) {
      out += child.text;
      continue;
    }
    if (typeof child !== 'object' || !('name' in child)) continue;

    if (child.name === 'text:s') {
      const count = Number(child.attributes.get('text:c') ?? '1');
      out += ' '.repeat(Number.isFinite(count) && count > 0 ? Math.min(count, 500) : 1);
    } else if (child.name === 'text:tab') {
      out += '\t';
    } else if (child.name === 'text:line-break') {
      out += '\n';
    } else {
      out += readText(child);
    }
  }
  return out;
}

function readNotes(page: XmlElement): string {
  const notes = firstChild(page, 'presentation:notes');
  if (notes === undefined) return '';

  const lines: string[] = [];
  for (const frame of childElements(notes, 'draw:frame')) {
    const box = firstChild(frame, 'draw:text-box');
    if (box === undefined) continue;
    for (const paragraph of childElements(box, 'text:p')) lines.push(readText(paragraph));
  }
  return lines.join('\n');
}

/* -------------------------------------------------------------- writing -- */

const NAMESPACES =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"';

export function writeOdp(presentation: Presentation): Uint8Array {
  const geometry = GEOMETRY[presentation.size];
  const widthCm = (geometry.width / 72) * 2.54;
  const heightCm = (geometry.height / 72) * 2.54;

  const pages = presentation.slides
    .map((slide, index) => pageXml(slide, index, widthCm, heightCm))
    .join('');

  const content =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<office:document-content ' + NAMESPACES + ' office:version="1.3">' +
    '<office:body><office:presentation>' + pages +
    '</office:presentation></office:body></office:document-content>';

  const styles =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<office:document-styles ' + NAMESPACES + ' office:version="1.3">' +
    '<office:automatic-styles>' +
    '<style:page-layout style:name="PM1"><style:page-layout-properties ' +
    'fo:page-width="' + widthCm.toFixed(3) + 'cm" fo:page-height="' + heightCm.toFixed(3) + 'cm"/>' +
    '</style:page-layout>' +
    '</office:automatic-styles>' +
    '</office:document-styles>';

  return writeZip([
    // The mimetype entry comes first in a real ODF package, and some readers
    // check exactly that.
    { name: 'mimetype', data: encoder.encode('application/vnd.oasis.opendocument.presentation') },
    {
      name: 'META-INF/manifest.xml',
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" ' +
          'manifest:version="1.3">' +
          '<manifest:file-entry manifest:full-path="/" ' +
          'manifest:media-type="application/vnd.oasis.opendocument.presentation"/>' +
          '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
          '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
          '</manifest:manifest>',
      ),
    },
    { name: 'content.xml', data: encoder.encode(content) },
    { name: 'styles.xml', data: encoder.encode(styles) },
  ]);
}

function pageXml(slide: Slide, index: number, widthCm: number, heightCm: number): string {
  const frames = slide.elements
    .filter((element): element is Extract<SlideElement, { kind: 'text' }> => element.kind === 'text')
    .map((element) => {
      const presentationClass =
        element.role === 'title'
          ? 'title'
          : element.role === 'subtitle'
            ? 'subtitle'
            : 'outline';

      return (
        '<draw:frame presentation:class="' + presentationClass + '"' +
        ' svg:x="' + (element.frame.x * widthCm).toFixed(3) + 'cm"' +
        ' svg:y="' + (element.frame.y * heightCm).toFixed(3) + 'cm"' +
        ' svg:width="' + (element.frame.width * widthCm).toFixed(3) + 'cm"' +
        ' svg:height="' + (element.frame.height * heightCm).toFixed(3) + 'cm">' +
        '<draw:text-box>' + linesXml(element.text) + '</draw:text-box>' +
        '</draw:frame>'
      );
    })
    .join('');

  const notes =
    slide.notes === ''
      ? ''
      : '<presentation:notes><draw:frame presentation:class="notes">' +
        '<draw:text-box>' + linesXml(slide.notes) + '</draw:text-box>' +
        '</draw:frame></presentation:notes>';

  return (
    '<draw:page draw:name="page' + (index + 1) + '">' + frames + notes + '</draw:page>'
  );
}

/**
 * One <text:p> per line, with runs of spaces encoded.
 *
 * Writing spaces literally loses them: XML collapses whitespace, so the file
 * round-trips through any conforming reader with the spacing gone.
 */
function linesXml(text: string): string {
  return text
    .split('\n')
    .map((line) => '<text:p>' + encodeSpaces(line) + '</text:p>')
    .join('');
}

function encodeSpaces(line: string): string {
  let out = '';
  let index = 0;
  while (index < line.length) {
    const character = line[index] as string;
    if (character === ' ') {
      let run = 1;
      while (line[index + run] === ' ') run += 1;
      // The first space is written literally and the rest as <text:s>, which is
      // what ODF producers emit: a leading <text:s> alone is also legal but
      // less widely handled.
      out += ' ';
      if (run > 1) out += '<text:s text:c="' + (run - 1) + '"/>';
      index += run;
      continue;
    }
    if (character === '\t') {
      out += '<text:tab/>';
      index += 1;
      continue;
    }
    out += escapeXml(character);
    index += 1;
  }
  return out;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
