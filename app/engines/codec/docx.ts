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
  | 'table';

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

export interface DocxBlock {
  readonly kind: DocxBlockKind;
  readonly runs: readonly DocxRun[];
  /** Set on a table block, and on no other kind. */
  readonly table?: DocxTable;
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

  const blocks: DocxBlock[] = [];
  // IN ORDER, and both kinds. Walking only `w:p` skips every table AND every
  // paragraph inside one, because those are nested rather than children of the
  // body - so a document with a table came back missing the table and its
  // contents, with nothing to say either had been there.
  for (const element of childElements(body)) {
    if (element.name === 'w:p') blocks.push(readParagraph(element, numbering));
    else if (element.name === 'w:tbl') blocks.push(readTable(element, numbering));
  }

  return { blocks, footnotes: readFootnotes(parts.get('word/footnotes.xml')) };
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

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: encoder.encode(contentTypes(notes.length > 0)) },
    { name: '_rels/.rels', data: encoder.encode(rootRelationships()) },
    { name: 'word/document.xml', data: encoder.encode(documentXml(document)) },
    { name: 'word/styles.xml', data: encoder.encode(stylesXml()) },
    { name: 'word/numbering.xml', data: encoder.encode(numberingXml()) },
    {
      name: 'word/_rels/document.xml.rels',
      data: encoder.encode(documentRelationships(notes.length > 0)),
    },
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

function contentTypes(withFootnotes: boolean): string {
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

function documentRelationships(withFootnotes: boolean): string {
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
    ],
  });
}

const WORD_NAMESPACE =
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function documentXml(document: DocxDocument): string {
  return writeXml({
    name: 'w:document',
    attributes: { 'xmlns:w': WORD_NAMESPACE },
    children: [
      {
        name: 'w:body',
        children: document.blocks.map((block) =>
          block.kind === 'table' && block.table !== undefined
            ? tableXml(block.table)
            : paragraphXml(block),
        ),
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
