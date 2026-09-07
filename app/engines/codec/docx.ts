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
  | 'code';

export interface DocxBlock {
  readonly kind: DocxBlockKind;
  readonly runs: readonly DocxRun[];
}

export interface DocxDocument {
  readonly blocks: readonly DocxBlock[];
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
  for (const paragraph of childElements(body, 'w:p')) {
    blocks.push(readParagraph(paragraph, numbering));
  }
  return { blocks };
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

    // A numbered list is a ListParagraph whose numbering id resolves, in the
    // numbering part, to a non-bullet format. Without this every ordered
    // list imports as a bullet list, which is a structural change the user
    // then has to undo by hand.
    const numberingProperties = firstChild(properties, 'w:numPr');
    if (numberingProperties !== undefined && kind === 'bullet') {
      const numberId = firstChild(numberingProperties, 'w:numId')?.attributes.get('w:val');
      if (numberId !== undefined && orderedNumbering.has(numberId)) {
        kind = 'numbered';
      }
    }
  }

  const runs: DocxRun[] = [];
  for (const runElement of childElements(paragraph, 'w:r')) {
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

  return { kind, runs };
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
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: encoder.encode(contentTypes()) },
    { name: '_rels/.rels', data: encoder.encode(rootRelationships()) },
    { name: 'word/document.xml', data: encoder.encode(documentXml(document)) },
    { name: 'word/styles.xml', data: encoder.encode(stylesXml()) },
    { name: 'word/numbering.xml', data: encoder.encode(numberingXml()) },
    {
      name: 'word/_rels/document.xml.rels',
      data: encoder.encode(documentRelationships()),
    },
  ];
  return writeZip(entries);
}

function contentTypes(): string {
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

function documentRelationships(): string {
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
        children: document.blocks.map((block) => paragraphXml(block)),
      },
    ],
  });
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

  for (const run of block.runs) {
    children.push(runXml(run));
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
