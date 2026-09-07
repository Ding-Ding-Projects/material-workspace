/**
 * A small XML reader and writer, sized for office documents.
 *
 * WHY NOT THE PLATFORM PARSER: DOMParser exists in the renderer and not in the
 * main process, so using it would mean the codecs could only run in one of the
 * two — and the codecs need to run wherever a file is opened. One
 * implementation, both places.
 *
 * WHY IT IS SAFE BY CONSTRUCTION: it resolves no external entities, follows no
 * DTD, and refuses a DOCTYPE outright. Those three are the whole of the XXE
 * and billion-laughs attack surface, and refusing them is far more reliable
 * than configuring a general parser to refuse them — a configuration flag can
 * be missed, and this simply has no code to do it.
 *
 * It is DELIBERATELY NOT a general XML parser. It handles what office formats
 * actually contain: elements, attributes, text, CDATA, comments, processing
 * instructions and the five predefined entities plus numeric references. It
 * does not handle namespaces as a resolution mechanism — office formats use
 * fixed, well-known prefixes, so a prefix is treated as part of the name,
 * which is what every practical reader of these formats does anyway.
 */

export interface XmlElement {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlNode[];
}

export type XmlNode = XmlElement | { readonly text: string };

export class XmlError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message + ' at position ' + position);
    this.name = 'XmlError';
  }
}

export function isElement(node: XmlNode): node is XmlElement {
  return (node as XmlElement).name !== undefined;
}

const QUOTE = String.fromCharCode(34);
const APOS = String.fromCharCode(39);

/** Bounds, so a hostile document cannot exhaust memory or the stack. */
const MAX_DEPTH = 256;

const ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', QUOTE],
  ['apos', APOS],
]);

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    // An unknown NAMED entity is left alone rather than resolved or dropped.
    // Resolving would require a DTD, which is the thing being refused.
    return ENTITIES.get(body) ?? whole;
  });
}

export function encodeText(text: string): string {
  return text
    .split('&')
    .join('&amp;')
    .split('<')
    .join('&lt;')
    .split('>')
    .join('&gt;');
}

export function encodeAttribute(text: string): string {
  return encodeText(text).split(QUOTE).join('&quot;').split(APOS).join('&apos;');
}

export function parseXml(source: string): XmlElement {
  let cursor = 0;
  const stack: { name: string; attributes: Map<string, string>; children: XmlNode[] }[] = [];
  let root: XmlElement | undefined;

  const skipWhitespace = (): void => {
    while (cursor < source.length && /\s/.test(source[cursor] as string)) cursor += 1;
  };

  while (cursor < source.length) {
    const openBracket = source.indexOf('<', cursor);

    if (openBracket < 0) break;

    // Text between elements.
    if (openBracket > cursor) {
      const raw = source.slice(cursor, openBracket);
      const frame = stack[stack.length - 1];
      if (frame !== undefined) {
        // Whitespace-only text between elements is structural, not content.
        // Keeping it would fill every parsed document with blank text nodes
        // that every caller then has to filter.
        if (raw.trim().length > 0) frame.children.push({ text: decodeEntities(raw) });
      }
      cursor = openBracket;
    }

    if (source.startsWith('<!--', cursor)) {
      const close = source.indexOf('-->', cursor);
      if (close < 0) throw new XmlError('unterminated comment', cursor);
      cursor = close + 3;
      continue;
    }

    if (source.startsWith('<![CDATA[', cursor)) {
      const close = source.indexOf(']]>', cursor);
      if (close < 0) throw new XmlError('unterminated CDATA', cursor);
      const frame = stack[stack.length - 1];
      // CDATA is literal: entities inside it are NOT resolved, which is the
      // entire point of it.
      if (frame !== undefined) frame.children.push({ text: source.slice(cursor + 9, close) });
      cursor = close + 3;
      continue;
    }

    if (source.startsWith('<?', cursor)) {
      const close = source.indexOf('?>', cursor);
      if (close < 0) throw new XmlError('unterminated processing instruction', cursor);
      cursor = close + 2;
      continue;
    }

    if (source.startsWith('<!DOCTYPE', cursor) || source.startsWith('<!doctype', cursor)) {
      // Refused outright rather than skipped. A DOCTYPE is where entity
      // expansion and external references live, and neither belongs in an
      // office document.
      throw new XmlError('a DOCTYPE is refused', cursor);
    }

    if (source.startsWith('</', cursor)) {
      const close = source.indexOf('>', cursor);
      if (close < 0) throw new XmlError('unterminated closing tag', cursor);
      const name = source.slice(cursor + 2, close).trim();
      const frame = stack.pop();
      if (frame === undefined) throw new XmlError('closing tag with nothing open', cursor);
      if (frame.name !== name) {
        throw new XmlError('closing ' + name + ' but ' + frame.name + ' is open', cursor);
      }
      const element: XmlElement = {
        name: frame.name,
        attributes: frame.attributes,
        children: frame.children,
      };
      const parent = stack[stack.length - 1];
      if (parent === undefined) root = element;
      else parent.children.push(element);
      cursor = close + 1;
      continue;
    }

    // An opening tag.
    cursor += 1;
    const nameStart = cursor;
    while (cursor < source.length && !/[\s/>]/.test(source[cursor] as string)) cursor += 1;
    const name = source.slice(nameStart, cursor);
    if (name.length === 0) throw new XmlError('a tag with no name', nameStart);

    const attributes = new Map<string, string>();
    for (;;) {
      skipWhitespace();
      if (cursor >= source.length) throw new XmlError('unterminated tag', nameStart);
      if (source.startsWith('/>', cursor) || source[cursor] === '>') break;

      const attributeStart = cursor;
      while (cursor < source.length && !/[\s=/>]/.test(source[cursor] as string)) cursor += 1;
      const attributeName = source.slice(attributeStart, cursor);
      if (attributeName.length === 0) throw new XmlError('a malformed attribute', cursor);

      skipWhitespace();
      if (source[cursor] !== '=') {
        // A valueless attribute. Not legal XML, but present in the wild, and
        // refusing the whole document over it helps nobody.
        attributes.set(attributeName, '');
        continue;
      }
      cursor += 1;
      skipWhitespace();

      const quote = source[cursor];
      if (quote !== QUOTE && quote !== APOS) {
        throw new XmlError('an unquoted attribute value', cursor);
      }
      cursor += 1;
      const valueStart = cursor;
      const valueEnd = source.indexOf(quote, cursor);
      if (valueEnd < 0) throw new XmlError('unterminated attribute value', valueStart);
      attributes.set(attributeName, decodeEntities(source.slice(valueStart, valueEnd)));
      cursor = valueEnd + 1;
    }

    const selfClosing = source.startsWith('/>', cursor);
    cursor += selfClosing ? 2 : 1;

    if (selfClosing) {
      const element: XmlElement = { name, attributes, children: [] };
      const parent = stack[stack.length - 1];
      if (parent === undefined) root = element;
      else parent.children.push(element);
      continue;
    }

    if (stack.length >= MAX_DEPTH) throw new XmlError('nesting is too deep', cursor);
    stack.push({ name, attributes, children: [] });
  }

  if (stack.length > 0) {
    throw new XmlError('unclosed element ' + (stack[stack.length - 1] as { name: string }).name, cursor);
  }
  if (root === undefined) throw new XmlError('no root element', 0);
  return root;
}

// ------------------------------------------------------------- navigation --

export function childElements(element: XmlElement, name?: string): XmlElement[] {
  const found: XmlElement[] = [];
  for (const child of element.children) {
    if (!isElement(child)) continue;
    if (name === undefined || child.name === name) found.push(child);
  }
  return found;
}

export function firstChild(element: XmlElement, name: string): XmlElement | undefined {
  for (const child of element.children) {
    if (isElement(child) && child.name === name) return child;
  }
  return undefined;
}

/** All descendant text, concatenated. */
export function textOf(element: XmlElement): string {
  let text = '';
  for (const child of element.children) {
    if (isElement(child)) text += textOf(child);
    else text += child.text;
  }
  return text;
}

// ---------------------------------------------------------------- writing --

export interface XmlWriteNode {
  readonly name: string;
  readonly attributes?: Readonly<Record<string, string | number | undefined>>;
  readonly children?: readonly (XmlWriteNode | string)[];
  /** Force a self-closing tag even with no children. */
  readonly empty?: boolean;
}

export function writeXml(root: XmlWriteNode, declaration = true): string {
  const parts: string[] = [];
  if (declaration) parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  parts.push(writeNode(root));
  return parts.join('\n');
}

function writeNode(node: XmlWriteNode): string {
  const attributes = Object.entries(node.attributes ?? {})
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => ' ' + key + '=' + QUOTE + encodeAttribute(String(value)) + QUOTE)
    .join('');

  const children = node.children ?? [];
  if (children.length === 0) return '<' + node.name + attributes + '/>';

  const inner = children
    .map((child) => (typeof child === 'string' ? encodeText(child) : writeNode(child)))
    .join('');
  return '<' + node.name + attributes + '>' + inner + '</' + node.name + '>';
}
