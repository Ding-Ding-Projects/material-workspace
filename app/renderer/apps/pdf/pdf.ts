/**
 * PDF.
 *
 * Open a file, inspect its structure, read its text, and redact it by removing
 * the bytes.
 *
 * IT NOW RENDERS PAGES, and the surface says exactly how much. Paths are drawn
 * faithfully - fills, colours, the graphics-state stack, transforms. TEXT is
 * placed faithfully and drawn with the canvas's own font, because the standard
 * fourteen fonts are not embedded and this engine has no glyph outlines for
 * them. Inventing shapes would be inventing a typeface, and a page in a
 * typeface nobody chose is worse than one in the viewer's own.
 *
 * Not drawn at all, and said so on the surface: embedded fonts, images,
 * shading, transparency, and any page whose content stream is compressed.
 * Those are absent rather than approximated - a page half-drawn from a
 * half-understood stream looks like a rendering and is not one.
 *
 * The other half is the part that is genuinely hard to get right elsewhere:
 * redaction that removes the bytes, and a check that proves it.
 */

import {
  type RenderedPage,
  drawPage as drawPdfPage,
} from '../../../engines/pdf/render.js';
import { clear, el } from '../../dom.js';
import {
  type PdfDocument,
  type PdfObject,
  containsText,
  readText,
  metadata,
  objectsOfType,
  pageCount,
  readPdf,
  removeObjects,
} from '../../../engines/pdf/reader.js';
import {
  A4,
  type Page as PdfPage,
  measureText,
  unsupportedCharacters,
  wrapText,
  writePdf,
} from '../../../engines/pdf/writer.js';

export interface PdfOptions {
  onChange?: () => void;
}

const latin = new TextDecoder('latin1');

export class PdfApp {
  readonly element: HTMLElement;

  private bytes: Uint8Array | null = null;
  private document: PdfDocument | null = null;
  private fileName = '';
  private selected = new Set<number>();
  private searchTerm = '';

  private readonly options: PdfOptions;

  private readonly toolbar: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private readonly searchInput: HTMLInputElement;
  private readonly summary: HTMLElement;
  private readonly objectList: HTMLElement;
  private readonly textPanel: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly pageNote: HTMLElement;
  private readonly statusLine: HTMLElement;
  private note = '';

  constructor(options: PdfOptions = {}) {
    this.options = options;

    this.fileInput = el('input', {
      class: 'pdf__file',
      type: 'file',
      accept: '.pdf,application/pdf',
      'aria-label': 'Open a PDF',
    }) as HTMLInputElement;

    this.searchInput = el('input', {
      class: 'pdf__search',
      type: 'search',
      'aria-label': 'Search the extracted text',
      placeholder: 'Search the text',
    }) as HTMLInputElement;

    this.toolbar = el('div', { class: 'pdf__toolbar', role: 'toolbar', 'aria-label': 'PDF' });
    this.summary = el('div', { class: 'pdf__summary' });
    this.objectList = el('div', {
      class: 'pdf__objects',
      role: 'listbox',
      'aria-multiselectable': 'true',
      'aria-label': 'Objects in this file',
    });
    this.textPanel = el('div', { class: 'pdf__text' });

    this.canvas = el('canvas', {
      class: 'pdf__canvas',
      // Named, because a canvas is invisible to a screen reader otherwise. The
      // text panel beside it carries the readable content; this says what the
      // picture is and, when it cannot be drawn, why.
      role: 'img',
      'aria-label': 'Page preview',
    }) as HTMLCanvasElement;
    this.pageNote = el('p', { class: 'pdf__page-note' });
    this.statusLine = el('div', {
      class: 'pdf__status',
      role: 'status',
      'aria-live': 'polite',
    });

    this.element = el('div', { class: 'pdf' }, [
      this.toolbar,
      this.summary,
      el('div', { class: 'pdf__body' }, [
        this.objectList,
        el('div', { class: 'pdf__page' }, [this.canvas, this.pageNote]),
        this.textPanel,
      ]),
      this.statusLine,
    ]);

    this.buildToolbar();
    this.wire();
    this.render();
  }

  private buildToolbar(): void {
    clear(this.toolbar);
    this.toolbar.append(
      el('span', { class: 'pdf__toolbar-label' }, ['Open']),
      this.fileInput,
      el('button', { class: 'pdf__action', type: 'button', 'data-action': 'sample' }, [
        'Make a sample',
      ]),
      this.searchInput,
      el(
        'button',
        {
          class: 'pdf__action pdf__action--danger',
          type: 'button',
          'data-action': 'redact',
          title:
            'Removes the selected objects from the file entirely. Not a black box drawn over them.',
        },
        ['Redact selected'],
      ),
      el('button', { class: 'pdf__action', type: 'button', 'data-action': 'save' }, ['Save']),
    );
  }

  private wire(): void {
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      if (!file) return;
      void this.openFile(file);
    });

    this.searchInput.addEventListener('input', () => {
      this.searchTerm = this.searchInput.value;
      void this.renderText();
      this.renderStatus();
    });

    this.toolbar.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('.pdf__action');
      if (!target) return;
      const action = target.getAttribute('data-action');
      if (action === 'sample') this.makeSample();
      else if (action === 'redact') this.redact();
      else if (action === 'save') this.save();
    });

    this.objectList.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('.pdf__object');
      if (!target) return;
      const number = Number(target.getAttribute('data-object'));
      if (this.selected.has(number)) this.selected.delete(number);
      else this.selected.add(number);
      this.renderObjects();
      this.renderStatus();
    });
  }

  private async openFile(file: File): Promise<void> {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      this.load(bytes, file.name);
    } catch (error) {
      this.note =
        'Could not open that file: ' + (error instanceof Error ? error.message : String(error));
      this.render();
    } finally {
      this.fileInput.value = '';
    }
  }

  private load(bytes: Uint8Array, name: string): void {
    try {
      this.document = readPdf(bytes);
      this.bytes = bytes;
      this.fileName = name;
      this.selected.clear();
      this.note = 'Opened ' + name + '.';
    } catch (error) {
      this.document = null;
      this.bytes = null;
      this.note = error instanceof Error ? error.message : String(error);
    }
    this.render();
  }

  /**
   * A sample built by this project's own writer.
   *
   * So the surface has something real to show without needing a file, and so
   * the redaction path can be demonstrated on a document whose secret is known.
   */
  private makeSample(): void {
    const margin = 72;
    const width = A4.width - margin * 2;

    const heading = 'Quarterly summary';
    const body =
      'This paragraph exists so the sample has real wrapped text in it. ' +
      'It is measured with the standard font metrics and broken to fit the ' +
      'page, exactly as an exported document would be.';

    const lines = wrapText(body, width, 11, 'Helvetica');
    const first: PdfPage = {
      ...A4,
      runs: [
        { text: heading, x: margin, y: A4.height - margin, size: 20, font: 'Helvetica-Bold' },
        ...lines.map((line, index) => ({
          text: line,
          x: margin,
          y: A4.height - margin - 34 - index * 15,
          size: 11,
          font: 'Helvetica' as const,
        })),
      ],
      lines: [
        {
          x1: margin,
          y1: A4.height - margin - 10,
          x2: A4.width - margin,
          y2: A4.height - margin - 10,
          width: 0.75,
          grey: 0.5,
        },
      ],
    };

    const second: PdfPage = {
      ...A4,
      runs: [
        {
          text: 'Confidential appendix',
          x: margin,
          y: A4.height - margin,
          size: 16,
          font: 'Helvetica-Bold',
        },
        {
          text: 'The account number is 4417-9982-0031.',
          x: margin,
          y: A4.height - margin - 30,
          size: 11,
          font: 'Helvetica',
        },
      ],
    };

    const bytes = writePdf([first, second], {
      title: 'Quarterly summary',
      author: 'Material Workspace',
      createdAt: 'D:20260101000000Z',
    });
    this.load(bytes, 'sample.pdf');
    this.note =
      'Built a two-page sample. The second page holds a secret, so redaction can be tried on it.';
    this.render();
  }

  /**
   * Redact by REMOVING the objects.
   *
   * Drawing a black rectangle over text leaves the text in the file, where it
   * can be selected, copied, or read in a text editor. That mistake has
   * exposed real secrets in real published documents, repeatedly.
   *
   * The result is verified by searching the new bytes for the text that was
   * removed. A redaction checked only by looking at the page is not checked.
   */
  private redact(): void {
    if (this.document === null || this.bytes === null) {
      this.note = 'Open a file first.';
      this.render();
      return;
    }
    if (this.selected.size === 0) {
      this.note = 'Select the objects to remove first. Their contents are listed on the left.';
      this.render();
      return;
    }

    // A sample of the text about to be removed, so the removal can be proved
    // rather than assumed.
    const removedText: string[] = [];
    for (const object of this.document.objects) {
      if (!this.selected.has(object.number) || object.stream === undefined) continue;
      const content = latin.decode(object.stream);
      for (const match of content.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
        const piece = (match[1] ?? '').replace(/\\(.)/g, '$1');
        if (piece.trim().length > 3) removedText.push(piece);
      }
    }

    const redacted = removeObjects(this.document, [...this.selected]);
    const survivors = removedText.filter((piece) => containsText(redacted, piece));

    this.bytes = redacted;
    this.document = readPdf(redacted);
    this.selected.clear();

    this.note =
      survivors.length === 0
        ? 'Removed ' +
          removedText.length +
          ' pieces of text from the file itself. Verified: none of them remain in the bytes.'
        : 'WARNING: ' +
          survivors.length +
          ' of the removed pieces are still present in the bytes. Do not treat this file as redacted.';

    this.options.onChange?.();
    this.render();
  }

  private save(): void {
    if (this.bytes === null) {
      this.note = 'Nothing to save yet.';
      this.render();
      return;
    }
    const blob = new Blob([this.bytes as BlobPart], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const anchor = el('a', {
      href: url,
      download: this.fileName === '' ? 'document.pdf' : this.fileName,
    }) as HTMLAnchorElement;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    this.note = 'Saved ' + this.bytes.length + ' bytes.';
    this.render();
  }

  // ------------------------------------------------------------- rendering --

  /**
   * Draw the first page onto the canvas.
   *
   * The display list is resolution independent, so this picks a width and
   * scales - which is what makes a zoom possible later without re-reading the
   * file.
   *
   * Every state that is NOT a drawn page says which it is: no document, a page
   * that could not be interpreted, or a page whose stream is compressed. A
   * blank canvas with no explanation is the decorative-surface defect at its
   * worst, because it looks exactly like a page that is genuinely empty.
   */
  private pageGeneration = 0;

  private async drawPage(): Promise<void> {
    const context = this.canvas.getContext('2d');
    if (context === null) {
      this.pageNote.textContent = 'This platform gave no 2D canvas, so nothing can be drawn.';
      return;
    }

    if (this.document === null) {
      this.canvas.width = 1;
      this.canvas.height = 1;
      this.pageNote.textContent = 'No document is open.';
      this.canvas.setAttribute('aria-label', 'No page to preview');
      return;
    }

    const generation = this.pageGeneration + 1;
    this.pageGeneration = generation;

    let drawn: { page: RenderedPage | null; reason: string };
    try {
      drawn = await drawPdfPage(this.document);
    } catch (error) {
      drawn = {
        page: null,
        reason:
          'No page could be drawn: ' + (error instanceof Error ? error.message : 'unknown fault'),
      };
    }
    // A later call started while this one was decompressing.
    if (generation !== this.pageGeneration) return;

    const page = drawn.page;
    if (page === null) {
      this.canvas.width = 1;
      this.canvas.height = 1;
      // The REASON, from the engine, rather than one sentence covering every
      // case. The old copy said this engine does not decompress, which was
      // true when it was written and became a false statement about the
      // product the moment it did.
      this.pageNote.textContent = drawn.reason;
      this.canvas.setAttribute('aria-label', 'This page could not be drawn');
      return;
    }

    const scale = Math.min(1, 420 / page.width);
    this.canvas.width = Math.round(page.width * scale);
    this.canvas.height = Math.round(page.height * scale);

    // White paper first. A transparent canvas shows whatever is behind it,
    // which on a dark theme is a black page.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);

    let drawnText = 0;
    for (const item of page.items) {
      if (item.kind === 'path') {
        context.beginPath();
        for (const command of item.commands) {
          if (command.op === 'move') context.moveTo(command.x * scale, command.y * scale);
          else if (command.op === 'line') context.lineTo(command.x * scale, command.y * scale);
          else if (command.op === 'curve') {
            context.bezierCurveTo(
              command.x1 * scale, command.y1 * scale,
              command.x2 * scale, command.y2 * scale,
              command.x * scale, command.y * scale,
            );
          } else context.closePath();
        }
        if (item.fill !== null) {
          context.fillStyle = css(item.fill);
          context.fill();
        }
        if (item.stroke !== null) {
          context.strokeStyle = css(item.stroke);
          context.lineWidth = Math.max(0.5, item.lineWidth * scale);
          context.stroke();
        }
        continue;
      }

      // Drawn with the canvas's own font. The size and position are the file's;
      // the shapes are the platform's, and the note below says so rather than
      // letting somebody believe these are the document's glyphs.
      context.fillStyle = css(item.colour);
      context.font = Math.max(1, item.size * scale) + 'px serif';
      context.fillText(item.text, item.x * scale, item.y * scale);
      drawnText += 1;
    }

    const paths = page.items.length - drawnText;
    this.pageNote.textContent =
      'Page 1: ' + paths + (paths === 1 ? ' shape' : ' shapes') + ' and ' +
      drawnText + (drawnText === 1 ? ' text run' : ' text runs') + '. ' +
      'Shapes are the document\'s own; text is positioned by the document and ' +
      'drawn in this application\'s font, because the standard fonts are not ' +
      'embedded. Images, shading and transparency are not drawn at all.';
    this.canvas.setAttribute(
      'aria-label',
      'Preview of page 1: ' + paths + ' shapes and ' + drawnText + ' text runs',
    );
  }

  private render(): void {
    this.renderSummary();
    this.renderObjects();
    void this.drawPage();
    void this.renderText();
    this.renderStatus();
  }

  private renderSummary(): void {
    clear(this.summary);

    if (this.document === null) {
      this.summary.append(
        el('p', { class: 'pdf__empty' }, [
          'No file open. Choose a PDF, or make a sample to try redaction on.',
        ]),
      );
      return;
    }

    const info = metadata(this.document);
    const rows: [string, string][] = [
      ['File', this.fileName],
      ['Version', 'PDF ' + this.document.version],
      ['Pages', String(pageCount(this.document))],
      ['Objects', String(this.document.objects.length)],
      ['Size', (this.bytes?.length ?? 0).toLocaleString() + ' bytes'],
    ];
    if (info.title !== undefined) rows.push(['Title', info.title]);
    if (info.author !== undefined) rows.push(['Author', info.author]);
    if (info.producer !== undefined) rows.push(['Producer', info.producer]);

    for (const [label, value] of rows) {
      this.summary.append(
        el('div', { class: 'pdf__summary-row' }, [
          el('span', { class: 'pdf__summary-label' }, [label]),
          el('span', { class: 'pdf__summary-value' }, [value]),
        ]),
      );
    }
  }

  private renderObjects(): void {
    clear(this.objectList);
    if (this.document === null) return;

    for (const object of this.document.objects) {
      const chosen = this.selected.has(object.number);
      this.objectList.append(
        el(
          'div',
          {
            class: 'pdf__object',
            role: 'option',
            'data-object': String(object.number),
            'data-selected': chosen ? 'true' : 'false',
            'aria-selected': chosen ? 'true' : 'false',
          },
          [
            el('span', { class: 'pdf__object-number' }, [String(object.number)]),
            el('span', { class: 'pdf__object-kind' }, [describeObject(object)]),
            el('span', { class: 'pdf__object-size' }, [
              object.stream === undefined
                ? String(object.body.length) + ' B'
                : String(object.stream.length) + ' B stream',
            ]),
          ],
        ),
      );
    }
  }

  /**
   * Rendering that has to wait for decompression.
   *
   * GUARDED BY A GENERATION, because it is asynchronous. Two calls that overlap
   * each clear the panel and then each append to it, and the interleaving
   * clear-clear-append-append leaves the document rendered twice - which the
   * drive caught as a two-page file reporting four pages. Nothing throws, and
   * the duplicate reads as real content.
   */
  private textGeneration = 0;

  private async renderText(): Promise<void> {
    const generation = this.textGeneration + 1;
    this.textGeneration = generation;
    clear(this.textPanel);

    if (this.document === null) {
      this.textPanel.append(
        el('p', { class: 'pdf__empty' }, ['Open a file to read its text.']),
      );
      return;
    }

    // Said on the surface, not only in the documentation. A grey rectangle
    // labelled "page" would be a decorative control, and this application
    // deliberately does not have one.
    this.textPanel.append(
      el('p', { class: 'pdf__caveat' }, [
        'This is the text STORED in the file, which is what a search and a ' +
          'redaction act on. The page beside it is drawn from the same file; ' +
          'the two can differ, because text drawn as outlines is a picture ' +
          'and is not stored as text at all.',
      ]),
    );

    const result = await readText(this.document);
    // A later call started while this one was decompressing. Its clear has
    // already happened, so appending here would land underneath its output.
    if (generation !== this.textGeneration) return;
    const pages = result.pages;

    // Said BEFORE the pages, because it changes what an empty result means.
    // "No readable text" on its own is indistinguishable from a document that
    // genuinely has none, and this reader has spent its whole life unable to
    // tell those two apart.
    if (result.images > 0) {
      this.textPanel.append(
        el('p', { class: 'pdf__caveat' }, [
          result.images +
            (result.images === 1 ? ' stream is an image' : ' streams are images') +
            ', so there is no stored text in ' +
            (result.images === 1 ? 'it' : 'them') +
            '. Scanned pages read like this.',
        ]),
      );
    }

    if (result.unreadable.length > 0) {
      this.textPanel.append(
        el('div', { class: 'pdf__problems', role: 'status' }, [
          el('p', {}, [
            result.unreadable.length +
              (result.unreadable.length === 1 ? ' stream' : ' streams') +
              ' could not be read, and its text is missing from what follows:',
          ]),
          el(
            'ul',
            { class: 'pdf__problem-list' },
            result.unreadable.map((reason) => el('li', {}, [reason])),
          ),
        ]),
      );
    }

    if (pages.length === 0) {
      this.textPanel.append(
        el('p', { class: 'pdf__empty' }, [
          result.unreadable.length > 0 || result.images > 0
            ? 'No text could be read from this file, for the reasons above.'
            : 'This file stores no text at all. Nothing was hidden by a filter.',
        ]),
      );
      return;
    }

    const needle = this.searchTerm.trim().toLowerCase();
    let shown = 0;

    pages.forEach((page, index) => {
      if (needle.length > 0 && !page.toLowerCase().includes(needle)) return;
      shown += 1;
      this.textPanel.append(
        el('div', { class: 'pdf__page' }, [
          el('span', { class: 'pdf__page-label' }, ['Page ' + (index + 1)]),
          el('pre', { class: 'pdf__page-text' }, [page]),
        ]),
      );
    });

    if (shown === 0) {
      this.textPanel.append(
        el('p', { class: 'pdf__empty' }, ['No page contains that text.']),
      );
    }
  }

  private renderStatus(): void {
    const parts: string[] = [];
    if (this.document === null) parts.push('No file open');
    else {
      parts.push(pageCount(this.document) + ' pages');
      parts.push(this.document.objects.length + ' objects');
      if (this.selected.size > 0) parts.push(this.selected.size + ' selected for removal');
    }
    if (this.note !== '') parts.push(this.note);

    clear(this.statusLine);
    this.statusLine.append(parts.join('   '));
    // Cleared after showing, so it does not follow the user around.
    this.note = '';
  }
}

function describeObject(object: PdfObject): string {
  const type = /\/Type\s*\/(\w+)/.exec(object.body)?.[1];
  if (type !== undefined) return type;
  if (object.stream !== undefined) {
    const content = latin.decode(object.stream.subarray(0, 200));
    if (/\bTj\b|\bTJ\b/.test(content)) return 'Content stream, with text';
    return 'Stream';
  }
  return 'Object';
}

export { measureText, unsupportedCharacters, objectsOfType };

/** A display-list colour as a CSS colour. */
function css(colour: { r: number; g: number; b: number }): string {
  const channel = (value: number): number => Math.max(0, Math.min(255, Math.round(value * 255)));
  return 'rgb(' + channel(colour.r) + ',' + channel(colour.g) + ',' + channel(colour.b) + ')';
}
