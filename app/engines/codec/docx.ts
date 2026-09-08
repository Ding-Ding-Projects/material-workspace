/**
 * `.docx`, read and written.
 *
 * The document model here is the same blocks-and-runs shape the text engine
 * uses, which is not a coincidence — the format is also blocks of runs, so the
 * two line up almost exactly. Where they differ is where the traps are:
 *
 *   - A PARAGRAPH IS NOT A LINE. `<w:p>` is a paragraph; line breaks inside it
 *     are `<w:br/>` elements. Treating every paragraph as a line, or every
 *     break as a paragraph, changes the document's structure rather than its
 *     appearance, and the difference survives into every later edit.
 *
 *   - WHITESPACE IS DROPPED UNLESS PRESERVED. A `<w:t>` without
 *     `xml:space="preserve"` has its leading and trailing spaces stripped by
 *     the reading application. So "Hello " + "world" silently becomes
 *     "Helloworld" — a real and very common corruption.
 *
 *   - A STYLE IS A REFERENCE, NOT A NAME. `<w:pStyle w:val="Heading1"/>` names
 *     a style ID defined elsewhere. The visible name in the styles part may be
 *     "heading 1", "Heading 1" or a localised string, so matching on the
 *     visible name works on English documents and fails on others.
 *
 *   - BOLD IS ABSENT, PRESENT, OR EXPLICITLY OFF. `<w:b/>` means on,
 *     `<w:b w:val="0"/>` means OFF, and absent means inherit. Treating the
 *     element's presence as truth makes explicitly-unbolded text bold.
 */

import {
  type XmlElement,
  type XmlWriteNode,
  childElements,
  firstChild,
  parseXml,
  textOf,
  writeXml,
} from './xml';
import { type ZipEntry, readZip, writeZip } from './zip';

export interface DocxRun {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
}

export type DocxBlockKind =
  | 'body'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bullet'
  | 'numbered'
  | 'quote'
  | 'code'
  | 'table'
  | 'image';

/** One cell of a table, holding whole paragraphs. */
export interface DocxCell {
  readonly blocks: readonly DocxBlock[];
}

export interface DocxTableRow {
  readonly cells: readonly DocxCell[];
  readonly header?: boolean;
}

export interface DocxTable {
  readonly rows: readonly DocxTableRow[];
  /**
   * Column widths in TWENTIETHS OF A POINT, which is what `w:w` carries.
   *
   * Points would be twenty times too narrow, and Word does not complain - it
   * draws a table a fifth of an inch wide and leaves the reader to wonder.
   */
  readonly gridWidths: readonly number[];
}

export interface DocxImage {
  /** The bytes, stored as their own part rather than inlined. */
  readonly data: Uint8Array;
  /** png, jpeg, gif - decides the Default content type the package declares. */
  readonly extension: string;
  /**
   * Size in ENGLISH METRIC UNITS: 914,400 to the inch, 12,700 to the point.
   *
   * Points would be seventy-two times too small, which Word renders without
   * complaint as an image a few pixels across - it looks like a broken file
   * rather than a unit mistake.
   */
  readonly widthEmu: number;
  readonly heightEmu: number;
  /** Never omitted. Word puts it in the shape's descr attribute. */
  readonly alt: string;
}

export interface DocxBlock {
  readonly kind: DocxBlockKind;
  readonly runs: readonly DocxRun[];
  /** Set on a table block, and on no other kind. */
  readonly table?: DocxTable;
  /** Set on an image block, and on no other kind. */
  readonly image?: DocxImage;
  /**
   * Footnote ids referenced from this paragraph, in the order they appear.
   *
   * The MARKER is not text. `<w:footnoteReference w:id="2"/>` is an element in
   * a run, and a reader that only collects `<w:t>` loses every reference while
   * keeping every note - which presents as a document whose notes belong to
   * nothing.
   */
  readonly footnoteRefs?: readonly string[];
  /**
   * True when this paragraph is a generated field, such as a table of contents.
   *
   * Kept so a refresh REPLACES it rather than stacking a second one, and so an
   * exporter can write it back as a field rather than as frozen text that a
   * reader can no longer update.
   */
  readonly field?: string;
}

export interface DocxFootnote {
  readonly id: string;
  readonly runs: readonly DocxRun[];
}

export interface DocxDocument {
  readonly blocks: readonly DocxBlock[];
  readonly footnotes?: readonly DocxFootnote[];
}

export class DocxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocxError';
  }
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Style identifiers.
 *
 * Matched on the ID, never on the visible name. The visible name is localised
 * in documents produced by a localised application, so name matching works in
 * English and quietly fails everywhere else.
 */
const STYLE_TO_KIND: ReadonlyMap<string, DocxBlockKind> = new Map([
  ['Heading1', 'heading1'],
  ['Heading2', 'heading2'],
  ['Heading3', 'heading3'],
  ['ListParagraph', 'bullet'],
  ['Quote', 'quote'],
  ['IntenseQuote', 'quote'],
  ['HTMLPreformatted', 'code'],
  ['Code', 'code'],
]);

const KIND_TO_STYLE: ReadonlyMap<DocxBlockKind, string> = new Map([
  ['heading1', 'Heading1'],
  ['heading2', 'Heading2'],
  ['heading3', 'Heading3'],
  ['bullet', 'ListParagraph'],
  ['numbered', 'ListParagraph'],
  ['quote', 'Quote'],
  ['code', 'Code'],
]);

// ------------------------------------------------------------------ reading --

export async function readDocx(bytes: Uint8Array): Promise<DocxDocument> {
  const parts = await readZip(bytes);
  const documentPart = parts.get('word/document.xml');
  if (documentPart === undefined) {
    throw new DocxError('word/document.xml is missing; this is not a docx file');
  }

  const root = parseXml(decoder.decode(documentPart));
  const body = firstChild(root, 'w:body');
  if (body === undefined) throw new DocxError('the document has no body');

  const numbering = readNumbering(parts.get('word/numbering.xml'));

  // The relationship map, so a blip's r:embed can be turned into a part name.
  // Without it the picture is a reference to nothing and the reader either
  // drops it or shows the wrong one.
  const relationships = readRelationships(parts.get('word/_rels/document.xml.rels'));

  const blocks: DocxBlock[] = [];
  // IN ORDER, and both kinds. Walking only `w:p` skips every table AND every
  // paragraph inside one, because those are nested rather than children of the
  // body - so a document with a table came back missing the table and its
  // contents, with nothing to say either had been there.
  for (const element of childElements(body)) {
    if (element.name === 'w:p') {
      const picture = readDrawing(element, relationships, parts);
      blocks.push(picture ?? readParagraph(element, numbering));
    } else if (element.name === 'w:tbl') blocks.push(readTable(element, numbering));
  }

  return { blocks, footnotes: readFootnotes(parts.get('word/footnotes.xml')) };
}

/** The relationship ids in a part, mapped to their targets. */
function readRelationships(part: Uint8Array | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (part === undefined) return map;

  const root = parseXml(decoder.decode(part));
  for (const element of childElements(root, 'Relationship')) {
    const id = element.attributes.get('Id');
    const target = element.attributes.get('Target');
    if (id !== undefined && target !== undefined) map.set(id, target);
  }
  return map;
}

/**
 * An inline picture, if this paragraph holds one.
 *
 * Returns null for an ordinary paragraph, so the caller falls through to the
 * text reader. A paragraph can hold a drawing AND text; this takes the drawing,
 * because a picture with a caption in the same paragraph is far rarer than a
 * picture on its own and losing the picture is the worse of the two.
 */
function readDrawing(
  paragraph: XmlElement,
  relationships: ReadonlyMap<string, string>,
  parts: ReadonlyMap<string, Uint8Array>,
): DocxBlock | null {
  const find = (element: XmlElement, name: string): XmlElement | undefined => {
    for (const child of childElements(element)) {
      if (child.name === name) return child;
      const deeper = find(child, name);
      if (deeper !== undefined) return deeper;
    }
    return undefined;
  };

  const blip = find(paragraph, 'a:blip');
  if (blip === undefined) return null;

  const id = blip.attributes.get('r:embed');
  if (id === undefined) return null;
  const target = relationships.get(id);
  if (target === undefined) return null;

  // Relationship targets are relative to the part's own folder, so a target of
  // "media/image1.png" from word/document.xml is word/media/image1.png. Reading
  // it as an absolute name finds nothing and the picture silently disappears.
  const name = target.startsWith('/') ? target.slice(1) : 'word/' + target;
  const data = parts.get(name);
  if (data === undefined) return null;

  const extent = find(paragraph, 'wp:extent');
  const properties = find(paragraph, 'wp:docPr');

  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();

  return {
    kind: 'image',
    runs: [],
    image: {
      data,
      extension,
      widthEmu: Number(extent?.attributes.get('cx') ?? '0'),
      heightEmu: Number(extent?.attributes.get('cy') ?? '0'),
      alt: properties?.attributes.get('descr') ?? '',
    },
  };
}

/**
 * A table.
 *
 * The grid is read from `w:tblGrid` where there is one and from the cells'
 * own `w:tcW` where there is not, because a producer may write either - and a
 * table whose widths are guessed opens a different shape from the one saved.
 */
function readTable(element: XmlElement, numbering: ReadonlySet<string>): DocxBlock {
  const gridWidths: number[] = [];
  const grid = firstChild(element, 'w:tblGrid');
  if (grid !== undefined) {
    for (const column of childElements(grid, 'w:gridCol')) {
      gridWidths.push(Number(column.attributes.get('w:w') ?? '2000'));
    }
  }

  const rows: DocxTableRow[] = [];
  for (const row of childElements(element, 'w:tr')) {
    const properties = firstChild(row, 'w:trPr');
    const header =
      properties !== undefined && firstChild(properties, 'w:tblHeader') !== undefined;

    const cells: DocxCell[] = [];
    for (const cell of childElements(row, 'w:tc')) {
      const blocks: DocxBlock[] = [];
      for (const paragraph of childElements(cell, 'w:p')) {
        blocks.push(readParagraph(paragraph, numbering));
      }
      cells.push({ blocks });

      if (gridWidths.length < cells.length) {
        const width = firstChild(cell, 'w:tcPr');
        const declared =
          width === undefined ? undefined : firstChild(width, 'w:tcW')?.attributes.get('w:w');
        gridWidths.push(Number(declared ?? '2000'));
      }
    }
    rows.push(header ? { cells, header: true } : { cells });
  }

  return { kind: 'table', runs: [], table: { rows, gridWidths } };
}

/**
 * The notes themselves, from their own part.
 *
 * TWO OF THEM ARE NOT NOTES. Word writes a separator and a continuation
 * separator as footnotes with ids 0 and -1 and `w:type` set, and a reader that
 * takes every `<w:footnote>` shows two empty notes at the top of every
 * document that has any - which looks like a parsing failure and is a
 * specification detail.
 */
function readFootnotes(part: Uint8Array | undefined): DocxFootnote[] {
  if (part === undefined) return [];

  const root = parseXml(decoder.decode(part));
  const notes: DocxFootnote[] = [];

  for (const element of childElements(root, 'w:footnote')) {
    const type = element.attributes.get('w:type');
    if (type === 'separator' || type === 'continuationSeparator') continue;

    const id = element.attributes.get('w:id');
    if (id === undefined || id === '0' || id === '-1') continue;

    const runs: DocxRun[] = [];
    for (const paragraph of childElements(element, 'w:p')) {
      for (const run of childElements(paragraph, 'w:r')) {
        const text = firstChild(run, 'w:t');
        if (text === undefined) continue;
        runs.push({ text: textOf(text) });
      }
    }
    notes.push({ id, runs });
  }

  return notes;
}

/**
 * Which numbering ids are ORDERED.
 *
 * The paragraph only carries a numbering id; whether that id produces
 * bullets or numbers is defined in a separate part. The first version of
 * this reader guessed from the id itself, which happened to work on files
 * this module wrote and would have been wrong on every real file.
 *
 * An id whose definition is missing is treated as UNORDERED, because a
 * bullet list is the far more common default and mislabelling a bullet as
 * a number is the more visible of the two errors.
 */
function readNumbering(part: Uint8Array | undefined): ReadonlySet<string> {
  const ordered = new Set<string>();
  if (part === undefined) return ordered;

  const root = parseXml(decoder.decode(part));

  // abstractNumId -> is it ordered
  const abstractOrdered = new Map<string, boolean>();
  for (const abstract of childElements(root, 'w:abstractNum')) {
    const id = abstract.attributes.get('w:abstractNumId');
    if (id === undefined) continue;
    const level = childElements(abstract, 'w:lvl').find(
      (candidate) => (candidate.attributes.get('w:ilvl') ?? '0') === '0',
    );
    const format = level === undefined ? undefined : firstChild(level, 'w:numFmt');
    const value = format?.attributes.get('w:val');
    abstractOrdered.set(id, value !== undefined && value !== 'bullet' && value !== 'none');
  }

  for (const num of childElements(root, 'w:num')) {
    const numId = num.attributes.get('w:numId');
    const abstractId = firstChild(num, 'w:abstractNumId')?.attributes.get('w:val');
    if (numId === undefined || abstractId === undefined) continue;
    if (abstractOrdered.get(abstractId) === true) ordered.add(numId);
  }

  return ordered;
}

function readParagraph(
  paragraph: XmlElement,
  orderedNumbering: ReadonlySet<string>,
): DocxBlock {
  const properties = firstChild(paragraph, 'w:pPr');
  let kind: DocxBlockKind = 'body';

  if (properties !== undefined) {
    const styleElement = firstChild(properties, 'w:pStyle');
    const styleId = styleElement?.attributes.get('w:val');
    if (styleId !== undefined) kind = STYLE_TO_KIND.get(styleId) ?? 'body';

    // <w:numPr> ALONE makes a paragraph a list item. Word usually writes a
    // ListParagraph style beside it, but it is not required to and several
    // common producers - Google Docs export, pandoc - do not. Requiring the
    // style meant a list from any of those imported as flat body text with the
    // numbering silently gone, which the conformance corpus caught on its
    // first run.
    //
    // Bullet is the safe default, and it becomes numbered when the numbering
    // id resolves to a non-bullet format. Without that every ordered list
    // imports as a bullet list, which is a structural change somebody then has
    // to undo by hand.
    const numberingProperties = firstChild(properties, 'w:numPr');
    if (numberingProperties !== undefined && (kind === 'bullet' || kind === 'body')) {
      const numberId = firstChild(numberingProperties, 'w:numId')?.attributes.get('w:val');
      kind = numberId !== undefined && orderedNumbering.has(numberId) ? 'numbered' : 'bullet';
    }
  }

  const runs: DocxRun[] = [];
  const footnoteRefs: string[] = [];
  let field: string | undefined;

  // A simple field carries its instruction on the element. The complex form -
  // three runs with fldChar begin, instrText and fldChar end - is read below,
  // because Word writes a table of contents that way and a reader that only
  // handles the simple form sees the frozen text and no field at all.
  const simple = firstChild(paragraph, 'w:fldSimple');
  if (simple !== undefined) {
    const instruction = simple.attributes.get('w:instr');
    if (instruction !== undefined) field = instruction.trim();
  }

  for (const runElement of childElements(paragraph, 'w:r')) {
    for (const reference of childElements(runElement, 'w:footnoteReference')) {
      const id = reference.attributes.get('w:id');
      if (id !== undefined) footnoteRefs.push(id);
    }
    const instruction = firstChild(runElement, 'w:instrText');
    if (instruction !== undefined) field = textOf(instruction).trim();

    const runProperties = firstChild(runElement, 'w:rPr');

    let text = '';
    for (const child of runElement.children) {
      if ((child as XmlElement).name === undefined) continue;
      const element = child as XmlElement;
      if (element.name === 'w:t') text += textOf(element);
      // A break inside a run is a line break WITHIN the paragraph, not a new
      // paragraph. Collapsing the two changes the document's structure.
      else if (element.name === 'w:br') text += '\n';
      else if (element.name === 'w:tab') text += '\t';
    }
    if (text === '') continue;

    runs.push({
      text,
      ...(toggle(runProperties, 'w:b') ? { bold: true } : {}),
      ...(toggle(runProperties, 'w:i') ? { italic: true } : {}),
      ...(underline(runProperties) ? { underline: true } : {}),
      ...(toggle(runProperties, 'w:strike') ? { strikethrough: true } : {}),
    });
  }

  return {
    kind,
    runs,
    ...(footnoteRefs.length > 0 ? { footnoteRefs } : {}),
    ...(field === undefined ? {} : { field }),
  };
}

/**
 * A toggle property is on, off, or inherited.
 *
 * Present with no value means ON. Present with val 0, false or off means OFF.
 * Absent means inherit, which at this level of the model is off. Treating mere
 * presence as truth makes explicitly-unbolded text bold, which is the exact
 * case somebody used the explicit off for.
 */
function toggle(properties: XmlElement | undefined, name: string): boolean {
  if (properties === undefined) return false;
  const element = firstChild(properties, name);
  if (element === undefined) return false;
  const value = element.attributes.get('w:val');
  if (value === undefined) return true;
  return value !== '0' && value !== 'false' && value !== 'off';
}

/** Underline is a STYLE, not a toggle: `w:val="none"` means no underline. */
function underline(properties: XmlElement | undefined): boolean {
  if (properties === undefined) return false;
  const element = firstChild(properties, 'w:u');
  if (element === undefined) return false;
  const value = element.attributes.get('w:val');
  return value !== 'none' && value !== undefined;
}

// ------------------------------------------------------------------ writing --

export function writeDocx(document: DocxDocument): Uint8Array {
  const notes = document.footnotes ?? [];

  // The images, numbered once, so the part name, the relationship id and the
  // reference in the body all agree. Numbering them independently in three
  // places is how a document ends up showing the wrong picture.
  const images = document.blocks
    .filter((block) => block.kind === 'image' && block.image !== undefined)
    .map((block, index) => ({
      block,
      image: block.image as DocxImage,
      name: 'media/image' + (index + 1) + '.' + (block.image as DocxImage).extension,
      // Offset past the fixed relationships this writer always emits.
      id: 'rId' + (index + 10),
    }));
  const imageIds = new Map(images.map((entry) => [entry.block, entry.id]));

  const entries: ZipEntry[] = [
    {
      name: '[Content_Types].xml',
      data: encoder.encode(
        contentTypes(
          notes.length > 0,
          [...new Set(images.map((entry) => entry.image.extension))],
        ),
      ),
    },
    { name: '_rels/.rels', data: encoder.encode(rootRelationships()) },
    { name: 'word/document.xml', data: encoder.encode(documentXml(document, imageIds)) },
    { name: 'word/styles.xml', data: encoder.encode(stylesXml()) },
    { name: 'word/numbering.xml', data: encoder.encode(numberingXml()) },
    {
      name: 'word/_rels/document.xml.rels',
      data: encoder.encode(
        documentRelationships(
          notes.length > 0,
          images.map((entry) => ({ id: entry.id, target: entry.name })),
        ),
      ),
    },
    ...images.map((entry) => ({ name: 'word/' + entry.name, data: entry.image.data })),
  ];

  if (notes.length > 0) {
    entries.push({ name: 'word/footnotes.xml', data: encoder.encode(footnotesXml(notes)) });
  }

  return writeZip(entries);
}

/**
 * The footnotes part.
 *
 * The separator and continuation separator come FIRST, with ids 0 and -1. They
 * are not notes - they are the rule Word draws above the notes area - and a
 * file without them opens with the notes running straight into the body text.
 * Every real producer writes them, so this does too.
 */
function footnotesXml(notes: readonly DocxFootnote[]): string {
  const body = notes
    .map(
      (note) =>
        '<w:footnote w:id="' + escapeAttribute(note.id) + '">' +
        '<w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>' +
        '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>' +
        note.runs
          .map(
            (run) =>
              '<w:r><w:t xml:space="preserve">' + escapeText(run.text) + '</w:t></w:r>',
          )
          .join('') +
        '</w:p></w:footnote>',
    )
    .join('');

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
    '<w:footnote w:type="continuationSeparator" w:id="0">' +
    '<w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
    body +
    '</w:footnotes>'
  );
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

function contentTypes(withFootnotes: boolean, imageExtensions: readonly string[] = []): string {
  return writeXml({
    name: 'Types',
    attributes: { xmlns: 'http://schemas.openxmlformats.org/package/2006/content-types' },
    children: [
      {
        name: 'Default',
        attributes: {
          Extension: 'rels',
          ContentType: 'application/vnd.openxmlformats-package.relationships+xml',
        },
      },
      { name: 'Default', attributes: { Extension: 'xml', ContentType: 'application/xml' } },
      // A media part with no Default for its extension makes Word refuse the
      // whole package, not merely the picture.
      ...imageExtensions.map((extension) => ({
        name: 'Default',
        attributes: {
          Extension: extension,
          ContentType: 'image/' + (extension === 'jpg' ? 'jpeg' : extension),
        },
      })),
      ...(withFootnotes
        ? [
            {
              name: 'Override',
              attributes: {
                PartName: '/word/footnotes.xml',
                ContentType:
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
              },
            },
          ]
        : []),
      {
        name: 'Override',
        attributes: {
          PartName: '/word/document.xml',
          ContentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
        },
      },
      {
        name: 'Override',
        attributes: {
          PartName: '/word/styles.xml',
          ContentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
        },
      },
      {
        name: 'Override',
        attributes: {
          PartName: '/word/numbering.xml',
          ContentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
        },
      },
    ],
  });
}

function rootRelationships(): string {
  return writeXml({
    name: 'Relationships',
    attributes: { xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships' },
    children: [
      {
        name: 'Relationship',
        attributes: {
          Id: 'rId1',
          Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
          Target: 'word/document.xml',
        },
      },
    ],
  });
}

function documentRelationships(
  withFootnotes: boolean,
  images: readonly { id: string; target: string }[] = [],
): string {
  return writeXml({
    name: 'Relationships',
    attributes: { xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships' },
    children: [
      {
        name: 'Relationship',
        attributes: {
          Id: 'rId1',
          Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
          Target: 'styles.xml',
        },
      },
      {
        name: 'Relationship',
        attributes: {
          Id: 'rId2',
          Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
          Target: 'numbering.xml',
        },
      },
      // Without this relationship the part is in the package and unreachable,
      // so the notes are there and no reader finds them - the exact
      // wired-at-one-end failure this project has met before.
      ...(withFootnotes
        ? [
            {
              name: 'Relationship',
              attributes: {
                Id: 'rId3',
                Type:
                  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes',
                Target: 'footnotes.xml',
              },
            },
          ]
        : []),
      // Same lesson one part over: a media part with no relationship is in the
      // package and unreachable, so the picture is there and nothing shows it.
      ...images.map((entry) => ({
        name: 'Relationship',
        attributes: {
          Id: entry.id,
          Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
          Target: entry.target,
        },
      })),
    ],
  });
}

/**
 * The drawing namespaces.
 *
 * All four are needed on the document element. Declaring them on the drawing
 * itself works in some readers and not in Word, which refuses the file rather
 * than the picture - and a file that will not open is far harder to diagnose
 * than one that opens wrong.
 */
const DRAWING_NS = {
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
};

const WORD_NAMESPACE =
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function documentXml(
  document: DocxDocument,
  imageIds: ReadonlyMap<DocxBlock, string> = new Map(),
): string {
  let pictureIndex = 0;

  return writeXml({
    name: 'w:document',
    attributes: {
      'xmlns:w': WORD_NAMESPACE,
      // All four on the document element. Declared on the drawing instead they
      // work in some readers and not in Word, which refuses the whole file
      // rather than the picture - and a file that will not open is far harder
      // to diagnose than one that opens wrong.
      'xmlns:wp': DRAWING_NS.wp,
      'xmlns:a': DRAWING_NS.a,
      'xmlns:pic': DRAWING_NS.pic,
      'xmlns:r': DRAWING_NS.r,
    },
    children: [
      {
        name: 'w:body',
        children: document.blocks.map((block) => {
          if (block.kind === 'table' && block.table !== undefined) return tableXml(block.table);
          const relationship = imageIds.get(block);
          if (block.kind === 'image' && block.image !== undefined && relationship !== undefined) {
            return drawingXml(block.image, relationship, pictureIndex++);
          }
          return paragraphXml(block);
        }),
      },
    ],
  });
}

/**
 * A table.
 *
 * `w:tblGrid` is not decoration: without it Word decides the column widths for
 * itself, which is rarely what the author chose, and a table that opens a
 * different shape from the one that was saved reads as a corrupted file.
 */
function tableXml(table: DocxTable): XmlWriteNode {
  const columns = Math.max(
    ...table.rows.map((row) => row.cells.length),
    table.gridWidths.length,
    1,
  );

  return {
    name: 'w:tbl',
    children: [
      {
        name: 'w:tblPr',
        children: [
          { name: 'w:tblStyle', attributes: { 'w:val': 'TableGrid' } },
          { name: 'w:tblW', attributes: { 'w:w': 0, 'w:type': 'auto' } },
          // Borders written out, because a table with none is a grid of
          // numbers that reads as a badly spaced paragraph.
          {
            name: 'w:tblBorders',
            children: ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((edge) => ({
              name: 'w:' + edge,
              attributes: { 'w:val': 'single', 'w:sz': 4, 'w:color': 'auto' },
            })),
          },
        ],
      },
      {
        name: 'w:tblGrid',
        children: Array.from({ length: columns }, (_, index) => ({
          name: 'w:gridCol',
          attributes: { 'w:w': Math.round(table.gridWidths[index] ?? 2000) },
        })),
      },
      ...table.rows.map((row) => ({
        name: 'w:tr',
        children: [
          ...(row.header === true
            ? [
                {
                  name: 'w:trPr',
                  // tblHeader is what makes Word repeat the row on each page.
                  // Without it a long table's second page has no labels.
                  children: [{ name: 'w:tblHeader' }],
                },
              ]
            : []),
          ...Array.from({ length: columns }, (_, index) => {
            const cell = row.cells[index];
            return {
              name: 'w:tc',
              children: [
                {
                  name: 'w:tcPr',
                  children: [
                    {
                      name: 'w:tcW',
                      attributes: {
                        'w:w': Math.round(table.gridWidths[index] ?? 2000),
                        'w:type': 'dxa',
                      },
                    },
                  ],
                },
                // A cell ALWAYS holds at least one paragraph. An empty w:tc is
                // invalid and Word refuses the whole file rather than the cell.
                ...(cell === undefined || cell.blocks.length === 0
                  ? [paragraphXml({ kind: 'body', runs: [] })]
                  : cell.blocks.map((inner) => paragraphXml(inner))),
              ],
            };
          }),
        ],
      })),
    ],
  };
}

/**
 * An inline picture.
 *
 * The shape is fixed by the specification and every element in it is load
 * bearing: `wp:extent` sizes it, `a:blip r:embed` is the only link to the media
 * part, and `docPr` carries the description a screen reader reads. Word refuses
 * a drawing that is missing any of them rather than drawing what it can.
 */
function drawingXml(image: DocxImage, relationshipId: string, index: number): XmlWriteNode {
  return {
    name: 'w:p',
    children: [
      {
        name: 'w:r',
        children: [
          {
            name: 'w:drawing',
            children: [
              {
                name: 'wp:inline',
                attributes: { distT: 0, distB: 0, distL: 0, distR: 0 },
                children: [
                  {
                    name: 'wp:extent',
                    attributes: { cx: Math.round(image.widthEmu), cy: Math.round(image.heightEmu) },
                  },
                  {
                    name: 'wp:docPr',
                    attributes: {
                      id: index + 1,
                      name: 'Picture ' + (index + 1),
                      // The alternative text. Omitting it makes the picture
                      // invisible to anybody using a screen reader, and Word
                      // offers no way to notice that it is missing.
                      descr: image.alt,
                    },
                  },
                  {
                    name: 'a:graphic',
                    children: [
                      {
                        name: 'a:graphicData',
                        attributes: { uri: DRAWING_NS.pic },
                        children: [
                          {
                            name: 'pic:pic',
                            children: [
                              {
                                name: 'pic:nvPicPr',
                                children: [
                                  {
                                    name: 'pic:cNvPr',
                                    attributes: {
                                      id: index + 1,
                                      name: 'Picture ' + (index + 1),
                                      descr: image.alt,
                                    },
                                  },
                                  { name: 'pic:cNvPicPr' },
                                ],
                              },
                              {
                                name: 'pic:blipFill',
                                children: [
                                  {
                                    name: 'a:blip',
                                    attributes: { 'r:embed': relationshipId },
                                  },
                                  { name: 'a:stretch', children: [{ name: 'a:fillRect' }] },
                                ],
                              },
                              {
                                name: 'pic:spPr',
                                children: [
                                  {
                                    name: 'a:xfrm',
                                    children: [
                                      { name: 'a:off', attributes: { x: 0, y: 0 } },
                                      {
                                        name: 'a:ext',
                                        attributes: {
                                          cx: Math.round(image.widthEmu),
                                          cy: Math.round(image.heightEmu),
                                        },
                                      },
                                    ],
                                  },
                                  {
                                    name: 'a:prstGeom',
                                    attributes: { prst: 'rect' },
                                    children: [{ name: 'a:avLst' }],
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function paragraphXml(block: DocxBlock): XmlWriteNode {
  const children: XmlWriteNode[] = [];

  const styleId = KIND_TO_STYLE.get(block.kind);
  if (styleId !== undefined) {
    const propertyChildren: XmlWriteNode[] = [
      { name: 'w:pStyle', attributes: { 'w:val': styleId } },
    ];
    if (block.kind === 'bullet' || block.kind === 'numbered') {
      propertyChildren.push({
        name: 'w:numPr',
        children: [
          { name: 'w:ilvl', attributes: { 'w:val': 0 } },
          // Different numbering ids, so a reader can tell an ordered list from
          // an unordered one. Sharing one id makes every list a bullet list.
          { name: 'w:numId', attributes: { 'w:val': block.kind === 'numbered' ? 2 : 1 } },
        ],
      });
    }
    children.push({ name: 'w:pPr', children: propertyChildren });
  }

  // A generated field is written back AS A FIELD, in the complex form Word
  // uses: fldChar begin, the instruction, fldChar separate, the frozen text a
  // reader without the field sees, fldChar end. Writing only the text would
  // make a table of contents that nobody can ever refresh again.
  if (block.field !== undefined) {
    children.push(
      {
        name: 'w:r',
        children: [{ name: 'w:fldChar', attributes: { 'w:fldCharType': 'begin' } }],
      },
      {
        name: 'w:r',
        children: [
          {
            name: 'w:instrText',
            attributes: { 'xml:space': 'preserve' },
            children: [block.field],
          },
        ],
      },
      {
        name: 'w:r',
        children: [{ name: 'w:fldChar', attributes: { 'w:fldCharType': 'separate' } }],
      },
    );
  }

  for (const run of block.runs) {
    children.push(runXml(run));
  }

  if (block.field !== undefined) {
    children.push({
      name: 'w:r',
      children: [{ name: 'w:fldChar', attributes: { 'w:fldCharType': 'end' } }],
    });
  }

  // The reference MARKERS, after the text they belong to. They are elements
  // inside a run rather than characters, and a writer that emits the number as
  // text produces a document where the marker cannot be clicked, cannot be
  // renumbered, and does not move when the note does.
  for (const id of block.footnoteRefs ?? []) {
    children.push({
      name: 'w:r',
      children: [
        {
          name: 'w:rPr',
          children: [{ name: 'w:rStyle', attributes: { 'w:val': 'FootnoteReference' } }],
        },
        { name: 'w:footnoteReference', attributes: { 'w:id': id } },
      ],
    });
  }

  return { name: 'w:p', children };
}

function runXml(run: DocxRun): XmlWriteNode {
  const properties: XmlWriteNode[] = [];
  if (run.bold === true) properties.push({ name: 'w:b' });
  if (run.italic === true) properties.push({ name: 'w:i' });
  if (run.underline === true) properties.push({ name: 'w:u', attributes: { 'w:val': 'single' } });
  if (run.strikethrough === true) properties.push({ name: 'w:strike' });

  const children: XmlWriteNode[] = [];
  if (properties.length > 0) children.push({ name: 'w:rPr', children: properties });

  // A line break inside a run must be a break ELEMENT. Leaving a raw newline
  // in the text is legal XML and renders as a space, so the break silently
  // disappears from the document.
  const pieces = run.text.split('\n');
  pieces.forEach((piece, index) => {
    if (index > 0) children.push({ name: 'w:br' });
    if (piece.length === 0) return;
    children.push({
      name: 'w:t',
      // Without this, leading and trailing spaces are stripped by the reading
      // application and words run together.
      attributes: { 'xml:space': 'preserve' },
      children: [piece],
    });
  });

  return { name: 'w:r', children };
}

/**
 * A minimal styles part.
 *
 * It exists because a document referencing a style that the styles part does
 * not define is opened by Word with a repair prompt. The definitions are
 * deliberately plain: this carries structure, not appearance.
 */
function stylesXml(): string {
  const styles: XmlWriteNode[] = [];
  for (const [kind, id] of KIND_TO_STYLE) {
    styles.push({
      name: 'w:style',
      attributes: { 'w:type': 'paragraph', 'w:styleId': id },
      children: [
        { name: 'w:name', attributes: { 'w:val': id } },
        ...(kind.startsWith('heading')
          ? [
              {
                name: 'w:pPr',
                children: [{ name: 'w:outlineLvl', attributes: { 'w:val': kind.slice(-1) } }],
              } as XmlWriteNode,
            ]
          : []),
      ],
    });
  }
  return writeXml({
    name: 'w:styles',
    attributes: { 'xmlns:w': WORD_NAMESPACE },
    children: styles,
  });
}

/**
 * The numbering part.
 *
 * Two definitions: id 1 is bullets, id 2 is decimals. Without this part a
 * reader has no way to tell an ordered list from an unordered one, because
 * the paragraph carries only the id \u2014 which is exactly the trap the reader
 * above documents.
 */
function numberingXml(): string {
  const level = (format: string, text: string): XmlWriteNode => ({
    name: 'w:lvl',
    attributes: { 'w:ilvl': 0 },
    children: [
      { name: 'w:numFmt', attributes: { 'w:val': format } },
      { name: 'w:lvlText', attributes: { 'w:val': text } },
    ],
  });

  return writeXml({
    name: 'w:numbering',
    attributes: { 'xmlns:w': WORD_NAMESPACE },
    children: [
      {
        name: 'w:abstractNum',
        attributes: { 'w:abstractNumId': 0 },
        children: [level('bullet', '\u2022')],
      },
      {
        name: 'w:abstractNum',
        attributes: { 'w:abstractNumId': 1 },
        children: [level('decimal', '%1.')],
      },
      {
        name: 'w:num',
        attributes: { 'w:numId': 1 },
        children: [{ name: 'w:abstractNumId', attributes: { 'w:val': 0 } }],
      },
      {
        name: 'w:num',
        attributes: { 'w:numId': 2 },
        children: [{ name: 'w:abstractNumId', attributes: { 'w:val': 1 } }],
      },
    ],
  });
}
