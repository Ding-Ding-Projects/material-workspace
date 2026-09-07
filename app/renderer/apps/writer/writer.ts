/**
 * Writer.
 *
 * A real editor over the text engine: the model holds blocks and runs, the
 * layout engine turns them into positioned lines on paginated pages, and this
 * surface renders those lines and manages the caret, the selection and input.
 *
 * It does NOT use contenteditable. That is a deliberate choice with a real cost
 * and a real payoff: contenteditable gives you input handling for free and takes
 * away any control over what the document actually contains, because every
 * browser has its own opinion about what pasting, undoing and pressing Enter
 * should do to the markup. Owning the model means the document is exactly what
 * the codecs, the autosave history and the collaboration layer think it is.
 *
 * Input arrives through a hidden, focused textarea, which is what gives us
 * working IME composition for Cantonese and Chinese input without reimplementing
 * it. A word processor that cannot accept Chinese input is not one.
 */

import { clear, el } from '../../dom.js';
import {
  applyFormatting,
  blockText,
  deleteRange,
  emptyDocument,
  formattingAcross,
  insertText,
  newBlockId,
  type Block,
  type BlockKind,
  type Run,
  type RunFormatting,
  type TextDocument,
} from '../../../engines/text/model.js';
import {
  canvasMeasurer,
  layout,
  type LaidOutLine,
  type LayoutResult,
  type TextMeasurer,
} from '../../../engines/text/layout.js';
import { readDocx, writeDocx } from '../../../engines/codec/docx.js';
import {
  describeConversionLoss,
  documentToDocx,
  docxToDocument,
} from '../../../engines/codec/docx-bridge.js';

/** Points to CSS pixels. 1pt = 1/72in, and CSS assumes 96dpi. */
const PT_TO_PX = 96 / 72;

export interface Caret {
  blockIndex: number;
  offset: number;
}

export interface WriterOptions {
  document?: TextDocument;
  /** Called whenever the document changes, for autosave. */
  onChange?: (document: TextDocument) => void;
  /** Called when the caret moves, for the status readout. */
  onCaret?: (caret: Caret, stats: DocumentStats) => void;
}

export interface DocumentStats {
  words: number;
  characters: number;
  pages: number;
  lines: number;
}

const BLOCK_LABELS: { kind: BlockKind; label: string }[] = [
  { kind: 'paragraph', label: 'Body text' },
  { kind: 'heading1', label: 'Heading 1' },
  { kind: 'heading2', label: 'Heading 2' },
  { kind: 'heading3', label: 'Heading 3' },
  { kind: 'bulleted', label: 'Bulleted list' },
  { kind: 'numbered', label: 'Numbered list' },
  { kind: 'quote', label: 'Quotation' },
  { kind: 'code', label: 'Code' },
];

export class Writer {
  readonly element: HTMLElement;

  private document: TextDocument;
  private readonly options: WriterOptions;
  private readonly measurer: TextMeasurer;

  private pagesHost: HTMLElement;
  private input: HTMLTextAreaElement;
  private caretElement: HTMLElement;
  private toolbar: HTMLElement;
  private fileBar: HTMLElement;
  private fileInput: HTMLInputElement;
  private fileNote: HTMLElement;
  private statsHost: HTMLElement;

  private caret: Caret = { blockIndex: 0, offset: 0 };
  private anchor: Caret | null = null;
  private laidOut: LayoutResult;
  /** Formatting to apply to the next character typed, when the caret is not
   *  inside a run that already carries it. */
  private pendingFormatting: RunFormatting = {};

  constructor(options: WriterOptions = {}) {
    this.options = options;
    this.document = options.document ?? emptyDocument();
    this.measurer = canvasMeasurer();

    this.pagesHost = el('div', {
      class: 'writer__pages',
      role: 'document',
      'aria-label': 'Document',
    });
    this.caretElement = el('div', { class: 'writer__caret', 'aria-hidden': 'true' });

    // The real input. Off-screen but focusable, so IME composition works for
    // Cantonese and Chinese without reimplementing it.
    this.input = el('textarea', {
      class: 'writer__input',
      'aria-label': 'Document text',
      autocomplete: 'off',
      autocorrect: 'off',
      autocapitalize: 'off',
      spellcheck: 'true',
    }) as HTMLTextAreaElement;

    this.toolbar = el('div', { class: 'writer__toolbar', role: 'toolbar', 'aria-label': 'Formatting' });

    this.fileInput = el('input', {
      class: 'writer__file',
      type: 'file',
      accept: '.docx,.txt,.md',
      'aria-label': 'Open a Word document or a text file',
    }) as HTMLInputElement;

    this.fileNote = el('div', {
      class: 'writer__note',
      role: 'status',
      'aria-live': 'polite',
      'data-shown': 'false',
    });

    this.fileBar = el('div', { class: 'writer__file-bar' }, [
      el('span', { class: 'writer__file-label' }, ['Open']),
      this.fileInput,
      el('span', { class: 'writer__file-label' }, ['Save as']),
      el(
        'button',
        {
          class: 'writer__save',
          type: 'button',
          'data-format': 'docx',
          title: 'Word document \u2014 keeps paragraph styles and bold, italic, underline and strikethrough',
        },
        ['Word document'],
      ),
      el(
        'button',
        {
          class: 'writer__save',
          type: 'button',
          'data-format': 'md',
          title: 'Markdown \u2014 loses: underline; strikethrough is kept as ~~',
        },
        ['Markdown'],
      ),
      el(
        'button',
        {
          class: 'writer__save',
          type: 'button',
          'data-format': 'txt',
          title: 'Plain text \u2014 loses: every style and every formatting mark',
        },
        ['Plain text'],
      ),
    ]);
    this.statsHost = el('p', {
      class: 'writer__stats',
      role: 'status',
      'aria-live': 'polite',
    });

    this.element = el('div', { class: 'writer' }, [
      this.fileBar,
      this.fileNote,
      this.toolbar,
      el('div', { class: 'writer__surface' }, [this.pagesHost, this.caretElement, this.input]),
      this.statsHost,
    ]);

    this.buildToolbar();
    this.wireFileBar();
    this.wireInput();

    this.laidOut = layout(this.document, this.measurer);
    this.render();
  }

  /* ---------------------------------------------------------- open/save */

  private wireFileBar(): void {
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      if (!file) return;
      void this.openFile(file);
    });

    for (const button of this.fileBar.querySelectorAll<HTMLElement>('.writer__save')) {
      button.addEventListener('click', () => {
        const format = button.getAttribute('data-format');
        if (format === 'docx') this.saveDocx();
        else if (format === 'md') this.saveText('md');
        else if (format === 'txt') this.saveText('txt');
      });
    }
  }

  /**
   * Open a file, dispatching on its BYTES rather than its extension.
   *
   * A .txt that is really a zip is a Word document somebody renamed, and
   * reading its binary as text produces a screen of mojibake rather than an
   * error anybody can act on.
   */
  private async openFile(file: File): Promise<void> {
    try {
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      const isZip =
        head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5);

      if (isZip) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        this.document = docxToDocument(await readDocx(bytes));
        this.setNote('Opened ' + this.document.blocks.length + ' paragraphs from ' + file.name + '.');
      } else {
        const text = await file.text();
        this.document = emptyDocument();
        this.document.blocks = text.split(/\r\n|\n|\r/).map((line) => ({
          id: newBlockId(),
          kind: 'paragraph' as BlockKind,
          runs: [{ text: line, formatting: {} }],
          style: {},
        }));
        this.setNote('Opened ' + this.document.blocks.length + ' lines from ' + file.name + '.');
      }

      this.caret = { blockIndex: 0, offset: 0 };
      this.anchor = null;
      this.commit();
    } catch (error) {
      this.setNote('Could not open that file: ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      // Cleared so choosing the same file twice fires a change event again.
      this.fileInput.value = '';
    }
  }

  private saveDocx(): void {
    // The loss is counted from THIS document and stated before the file is
    // written, rather than described generically afterwards.
    const losses = describeConversionLoss(this.document);
    const bytes = writeDocx(documentToDocx(this.document));
    this.download(
      bytes,
      'document.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    this.setNote(
      'Saved as a Word document.' +
        (losses.length === 0 ? ' Nothing was lost.' : ' Not carried: ' + losses.join('; ') + '.'),
    );
  }

  private saveText(format: 'md' | 'txt'): void {
    const lines: string[] = [];
    for (const block of this.document.blocks) {
      if (block.kind === 'pageBreak') {
        lines.push(format === 'md' ? '---' : '');
        continue;
      }
      const text = block.runs
        .filter((run) => run.formatting.deleted === undefined)
        .map((run) => (format === 'md' ? markdownRun(run) : run.text))
        .join('');
      lines.push(format === 'md' ? markdownPrefix(block.kind) + text : text);
    }

    const encoded = new TextEncoder().encode(lines.join('\n'));
    this.download(
      encoded,
      format === 'md' ? 'document.md' : 'document.txt',
      format === 'md' ? 'text/markdown' : 'text/plain',
    );
    this.setNote(
      format === 'md'
        ? 'Saved as Markdown. Not carried: underline.'
        : 'Saved as plain text. Not carried: every style and every formatting mark.',
    );
  }

  private download(bytes: Uint8Array, name: string, mediaType: string): void {
    const blob = new Blob([bytes as BlobPart], { type: mediaType });
    const url = URL.createObjectURL(blob);
    const anchor = el('a', { href: url, download: name }) as HTMLAnchorElement;
    anchor.click();
    // Revoked on the next turn. Revoking immediately can beat the download
    // in some builds, producing an empty file and no error at all.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  private setNote(message: string): void {
    clear(this.fileNote);
    this.fileNote.append(message);
    this.fileNote.setAttribute('data-shown', message === '' ? 'false' : 'true');
  }

  /* ------------------------------------------------------------- toolbar */

  private buildToolbar(): void {
    clear(this.toolbar);

    const select = el('select', {
      class: 'writer__block-kind',
      'aria-label': 'Paragraph style',
    }) as HTMLSelectElement;
    for (const entry of BLOCK_LABELS) {
      select.append(el('option', { value: entry.kind, text: entry.label }));
    }
    select.value = this.currentBlock()?.kind ?? 'paragraph';
    select.addEventListener('change', () => {
      const block = this.currentBlock();
      if (!block) return;
      block.kind = select.value as BlockKind;
      this.commit();
    });
    this.toolbar.append(select);

    const toggle = (
      key: 'bold' | 'italic' | 'underline' | 'strikethrough',
      label: string,
      glyph: string,
      shortcut: string,
    ): void => {
      const button = el('button', {
        class: 'writer__format',
        type: 'button',
        'data-format': key,
        // The shortcut that ACTUALLY works, so the control is learnable from
        // where people look for it.
        'aria-label': label + ' (' + shortcut + ')',
        title: label + '  ' + shortcut,
        'aria-pressed': 'false',
      });
      button.textContent = glyph;
      button.addEventListener('mousedown', (event) => {
        // Keep focus in the input so the caret does not disappear.
        event.preventDefault();
      });
      button.addEventListener('click', () => this.toggleFormatting(key));
      this.toolbar.append(button);
    };

    toggle('bold', 'Bold', 'B', 'Ctrl+B');
    toggle('italic', 'Italic', 'I', 'Ctrl+I');
    toggle('underline', 'Underline', 'U', 'Ctrl+U');
    toggle('strikethrough', 'Strikethrough', 'S', 'Ctrl+Shift+X');
  }

  private refreshToolbarState(): void {
    const active = this.activeFormatting();
    for (const button of this.toolbar.querySelectorAll<HTMLElement>('.writer__format')) {
      const key = button.getAttribute('data-format') as keyof RunFormatting;
      button.setAttribute('aria-pressed', String(active[key] === true));
    }
    const select = this.toolbar.querySelector<HTMLSelectElement>('.writer__block-kind');
    if (select) select.value = this.currentBlock()?.kind ?? 'paragraph';
  }

  /* --------------------------------------------------------------- model */

  private currentBlock(): Block | undefined {
    return this.document.blocks[this.caret.blockIndex];
  }

  /** The formatting in effect at the caret, or across the selection. */
  private activeFormatting(): RunFormatting {
    const block = this.currentBlock();
    if (!block) return {};
    const range = this.selectionRange();
    if (range && range.startBlock === range.endBlock) {
      return formattingAcross(block, range.startOffset, range.endOffset);
    }
    // A collapsed caret reports the formatting immediately before it, plus
    // anything the user has toggled but not yet typed.
    const at = Math.max(0, this.caret.offset - 1);
    return { ...formattingAcross(block, at, at + 1), ...this.pendingFormatting };
  }

  private selectionRange(): {
    startBlock: number;
    startOffset: number;
    endBlock: number;
    endOffset: number;
  } | null {
    if (!this.anchor) return null;
    const a = this.anchor;
    const b = this.caret;
    const forward =
      a.blockIndex < b.blockIndex || (a.blockIndex === b.blockIndex && a.offset <= b.offset);
    const start = forward ? a : b;
    const end = forward ? b : a;
    if (start.blockIndex === end.blockIndex && start.offset === end.offset) return null;
    return {
      startBlock: start.blockIndex,
      startOffset: start.offset,
      endBlock: end.blockIndex,
      endOffset: end.offset,
    };
  }

  private toggleFormatting(key: 'bold' | 'italic' | 'underline' | 'strikethrough'): void {
    const active = this.activeFormatting();
    const next = active[key] !== true;
    const range = this.selectionRange();

    if (range && range.startBlock === range.endBlock) {
      const block = this.document.blocks[range.startBlock];
      if (block) applyFormatting(block, range.startOffset, range.endOffset, { [key]: next });
      this.commit();
      return;
    }

    if (range) {
      // A multi-block selection: apply to each block's covered span.
      for (let index = range.startBlock; index <= range.endBlock; index += 1) {
        const block = this.document.blocks[index];
        if (!block) continue;
        const from = index === range.startBlock ? range.startOffset : 0;
        const to = index === range.endBlock ? range.endOffset : blockText(block).length;
        applyFormatting(block, from, to, { [key]: next });
      }
      this.commit();
      return;
    }

    // No selection: remember it for the next character typed.
    this.pendingFormatting = { ...this.pendingFormatting, [key]: next };
    this.refreshToolbarState();
  }

  private deleteSelection(): boolean {
    const range = this.selectionRange();
    if (!range) return false;

    if (range.startBlock === range.endBlock) {
      const block = this.document.blocks[range.startBlock];
      if (block) deleteRange(block, range.startOffset, range.endOffset);
      this.caret = { blockIndex: range.startBlock, offset: range.startOffset };
    } else {
      const first = this.document.blocks[range.startBlock];
      const last = this.document.blocks[range.endBlock];
      if (first) deleteRange(first, range.startOffset, blockText(first).length);
      if (last) deleteRange(last, 0, range.endOffset);
      if (first && last) {
        // Join the two ends into one block, which is what deleting across a
        // paragraph boundary means.
        first.runs = [...first.runs, ...last.runs].filter(
          (run, index, all) => run.text.length > 0 || index === all.length - 1,
        );
      }
      this.document.blocks.splice(range.startBlock + 1, range.endBlock - range.startBlock);
      this.caret = { blockIndex: range.startBlock, offset: range.startOffset };
    }

    this.anchor = null;
    return true;
  }

  /* --------------------------------------------------------------- input */

  private wireInput(): void {
    this.input.addEventListener('beforeinput', (event: InputEvent) => {
      // Composition (IME) is handled by the browser and delivered as a single
      // insertText when it commits, which is exactly what we want.
      if (event.inputType === 'insertText' && typeof event.data === 'string') {
        event.preventDefault();
        this.type(event.data);
      }
    });

    this.input.addEventListener('keydown', (event: KeyboardEvent) => this.onKeyDown(event));

    this.input.addEventListener('paste', (event: ClipboardEvent) => {
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (text.length === 0) return;
      // Paste is split on newlines into real blocks rather than inserted as one
      // run containing line breaks the model cannot represent.
      const parts = text.replace(/\r\n/g, '\n').split('\n');
      for (const [index, part] of parts.entries()) {
        if (index > 0) this.splitBlock();
        if (part.length > 0) this.type(part);
      }
    });

    this.pagesHost.addEventListener('mousedown', (event: MouseEvent) => {
      const hit = this.hitTest(event.clientX, event.clientY);
      if (!hit) return;
      this.anchor = event.shiftKey ? (this.anchor ?? this.caret) : null;
      this.caret = hit;
      this.pendingFormatting = {};
      this.input.focus();
      this.render();
    });
  }

  private type(text: string): void {
    const changed = this.deleteSelection();
    void changed;
    const block = this.currentBlock();
    if (!block) return;
    insertText(block, this.caret.offset, text);

    if (Object.keys(this.pendingFormatting).length > 0) {
      applyFormatting(
        block,
        this.caret.offset,
        this.caret.offset + text.length,
        this.pendingFormatting,
      );
    }
    this.caret = { blockIndex: this.caret.blockIndex, offset: this.caret.offset + text.length };
    this.commit();
  }

  private splitBlock(): void {
    this.deleteSelection();
    const block = this.currentBlock();
    if (!block) return;
    const text = blockText(block);
    const tail = text.slice(this.caret.offset);
    deleteRange(block, this.caret.offset, text.length);

    const next: Block = {
      id: newBlockId(),
      // Pressing Enter at the end of a heading gives you body text, because
      // that is what somebody who just wrote a heading is about to type.
      kind: block.kind.startsWith('heading') ? 'paragraph' : block.kind,
      runs: [{ text: tail, formatting: {} }],
      style: { ...block.style },
    };
    this.document.blocks.splice(this.caret.blockIndex + 1, 0, next);
    this.caret = { blockIndex: this.caret.blockIndex + 1, offset: 0 };
    this.commit();
  }

  private onKeyDown(event: KeyboardEvent): void {
    const block = this.currentBlock();
    if (!block) return;
    const text = blockText(block);

    const extend = event.shiftKey;
    const beginSelection = (): void => {
      if (extend && !this.anchor) this.anchor = { ...this.caret };
      if (!extend) this.anchor = null;
    };

    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase();
      if (key === 'b' || key === 'i' || key === 'u') {
        event.preventDefault();
        this.toggleFormatting(key === 'b' ? 'bold' : key === 'i' ? 'italic' : 'underline');
        return;
      }
      if (key === 'x' && event.shiftKey) {
        event.preventDefault();
        this.toggleFormatting('strikethrough');
        return;
      }
      if (key === 'a') {
        event.preventDefault();
        this.anchor = { blockIndex: 0, offset: 0 };
        const lastIndex = this.document.blocks.length - 1;
        const last = this.document.blocks[lastIndex];
        this.caret = { blockIndex: lastIndex, offset: last ? blockText(last).length : 0 };
        this.render();
        return;
      }
      return;
    }

    switch (event.key) {
      case 'Enter':
        event.preventDefault();
        this.splitBlock();
        return;

      case 'Backspace': {
        event.preventDefault();
        if (this.deleteSelection()) {
          this.commit();
          return;
        }
        if (this.caret.offset > 0) {
          deleteRange(block, this.caret.offset - 1, this.caret.offset);
          this.caret = { ...this.caret, offset: this.caret.offset - 1 };
        } else if (this.caret.blockIndex > 0) {
          // Join with the previous block, which is what Backspace at the start
          // of a paragraph means.
          const previous = this.document.blocks[this.caret.blockIndex - 1];
          if (previous) {
            const joinAt = blockText(previous).length;
            previous.runs = [...previous.runs, ...block.runs].filter((run) => run.text.length > 0);
            if (previous.runs.length === 0) previous.runs = [{ text: '', formatting: {} }];
            this.document.blocks.splice(this.caret.blockIndex, 1);
            this.caret = { blockIndex: this.caret.blockIndex - 1, offset: joinAt };
          }
        }
        this.commit();
        return;
      }

      case 'Delete': {
        event.preventDefault();
        if (this.deleteSelection()) {
          this.commit();
          return;
        }
        if (this.caret.offset < text.length) {
          deleteRange(block, this.caret.offset, this.caret.offset + 1);
        } else if (this.caret.blockIndex < this.document.blocks.length - 1) {
          const next = this.document.blocks[this.caret.blockIndex + 1];
          if (next) {
            block.runs = [...block.runs, ...next.runs].filter((run) => run.text.length > 0);
            if (block.runs.length === 0) block.runs = [{ text: '', formatting: {} }];
            this.document.blocks.splice(this.caret.blockIndex + 1, 1);
          }
        }
        this.commit();
        return;
      }

      case 'ArrowLeft':
        event.preventDefault();
        beginSelection();
        if (this.caret.offset > 0) this.caret = { ...this.caret, offset: this.caret.offset - 1 };
        else if (this.caret.blockIndex > 0) {
          const previous = this.document.blocks[this.caret.blockIndex - 1];
          this.caret = {
            blockIndex: this.caret.blockIndex - 1,
            offset: previous ? blockText(previous).length : 0,
          };
        }
        this.render();
        return;

      case 'ArrowRight':
        event.preventDefault();
        beginSelection();
        if (this.caret.offset < text.length) this.caret = { ...this.caret, offset: this.caret.offset + 1 };
        else if (this.caret.blockIndex < this.document.blocks.length - 1) {
          this.caret = { blockIndex: this.caret.blockIndex + 1, offset: 0 };
        }
        this.render();
        return;

      case 'ArrowUp':
      case 'ArrowDown': {
        event.preventDefault();
        beginSelection();
        this.moveVertically(event.key === 'ArrowDown' ? 1 : -1);
        this.render();
        return;
      }

      case 'Home':
        event.preventDefault();
        beginSelection();
        this.caret = { ...this.caret, offset: this.lineStartOffset() };
        this.render();
        return;

      case 'End':
        event.preventDefault();
        beginSelection();
        this.caret = { ...this.caret, offset: this.lineEndOffset() };
        this.render();
        return;

      default:
        return;
    }
  }

  /* ------------------------------------------------------------- geometry */

  private allLines(): LaidOutLine[] {
    return this.laidOut.pages.flatMap((page) => page.lines);
  }

  private lineForCaret(): LaidOutLine | undefined {
    const block = this.currentBlock();
    if (!block) return undefined;
    const lines = this.allLines().filter((line) => line.blockId === block.id);
    return (
      lines.find((line) => this.caret.offset >= line.start && this.caret.offset <= line.end) ??
      lines.at(-1)
    );
  }

  private lineStartOffset(): number {
    return this.lineForCaret()?.start ?? 0;
  }

  private lineEndOffset(): number {
    return this.lineForCaret()?.end ?? 0;
  }

  private moveVertically(direction: 1 | -1): void {
    const lines = this.allLines();
    const current = this.lineForCaret();
    if (!current) return;
    const index = lines.indexOf(current);
    const target = lines[index + direction];
    if (!target) return;

    const column = this.caret.offset - current.start;
    const blockIndex = this.document.blocks.findIndex((block) => block.id === target.blockId);
    if (blockIndex === -1) return;
    this.caret = {
      blockIndex,
      offset: Math.min(target.start + column, target.end),
    };
  }

  /** Which caret position a point corresponds to. */
  private hitTest(clientX: number, clientY: number): Caret | null {
    const pageElements = [...this.pagesHost.querySelectorAll<HTMLElement>('.writer__page')];
    let best: { caret: Caret; distance: number } | null = null;

    for (const [pageIndex, pageElement] of pageElements.entries()) {
      const page = this.laidOut.pages[pageIndex];
      if (!page) continue;
      const box = pageElement.getBoundingClientRect();

      for (const line of page.lines) {
        const lineTop = box.top + (page.marginTop + line.y) * PT_TO_PX;
        const lineBottom = lineTop + line.height * PT_TO_PX;
        const centre = (lineTop + lineBottom) / 2;
        const distance = Math.abs(clientY - centre);

        if (best && distance >= best.distance) continue;

        // Walk every character boundary on the line and keep the one nearest
        // the pointer. Boundaries, not characters: clicking in the right-hand
        // half of a letter must put the caret AFTER it, which is what every
        // other editor does and what people expect without being able to say so.
        const lineLeft = box.left + page.marginLeft * PT_TO_PX;
        let offset = line.start;
        let closest = Math.abs(clientX - lineLeft);
        let x = lineLeft;
        let consumed = line.start;

        for (const run of line.runs) {
          const perCharacter = (run.width * PT_TO_PX) / Math.max(1, run.text.length);
          for (let index = 0; index < run.text.length; index += 1) {
            x += perCharacter;
            const boundary = consumed + index + 1;
            const distanceToBoundary = Math.abs(clientX - x);
            if (distanceToBoundary < closest) {
              closest = distanceToBoundary;
              offset = boundary;
            }
          }
          consumed += run.text.length;
        }

        const blockIndex = this.document.blocks.findIndex((block) => block.id === line.blockId);
        if (blockIndex === -1) continue;
        best = { caret: { blockIndex, offset }, distance };
      }
    }

    return best?.caret ?? null;
  }

  /* -------------------------------------------------------------- render */

  private commit(): void {
    this.laidOut = layout(this.document, this.measurer);
    this.render();
    this.options.onChange?.(this.document);
  }

  private stats(): DocumentStats {
    const text = this.document.blocks.map(blockText).join(' ');
    const words = text.split(/\s+/).filter((word) => word.length > 0).length;
    return {
      words,
      characters: text.replace(/\s/g, '').length,
      pages: this.laidOut.pages.length,
      lines: this.laidOut.lineCount,
    };
  }

  render(): void {
    clear(this.pagesHost);

    for (const page of this.laidOut.pages) {
      const pageElement = el('div', {
        class: 'writer__page',
        'data-page': String(page.index),
        'aria-label': 'Page ' + (page.index + 1),
      });
      pageElement.style.inlineSize = page.width * PT_TO_PX + 'px';
      pageElement.style.blockSize = page.height * PT_TO_PX + 'px';

      for (const line of page.lines) {
        const lineElement = el('div', { class: 'writer__line' });
        lineElement.style.insetInlineStart = page.marginLeft * PT_TO_PX + 'px';
        lineElement.style.insetBlockStart = (page.marginTop + line.y) * PT_TO_PX + 'px';
        lineElement.style.blockSize = line.height * PT_TO_PX + 'px';

        for (const run of line.runs) {
          const span = el('span', { class: 'writer__run' });
          span.textContent = run.text;
          const style = span.style;
          if (run.formatting.bold) style.fontWeight = '700';
          if (run.formatting.italic) style.fontStyle = 'italic';
          const decorations: string[] = [];
          if (run.formatting.underline) decorations.push('underline');
          if (run.formatting.strikethrough) decorations.push('line-through');
          if (decorations.length > 0) style.textDecoration = decorations.join(' ');
          if (run.formatting.colour) style.color = run.formatting.colour;
          if (run.formatting.highlight) style.backgroundColor = run.formatting.highlight;
          lineElement.append(span);
        }

        pageElement.append(lineElement);
      }

      this.pagesHost.append(pageElement);
    }

    this.positionCaret();
    this.refreshToolbarState();

    const stats = this.stats();
    this.statsHost.textContent =
      stats.words +
      (stats.words === 1 ? ' word' : ' words') +
      ' · ' +
      stats.characters +
      ' characters · ' +
      stats.pages +
      (stats.pages === 1 ? ' page' : ' pages');
    this.options.onCaret?.(this.caret, stats);
  }

  private positionCaret(): void {
    const line = this.lineForCaret();
    if (!line) return;
    const pageIndex = this.laidOut.pages.findIndex((page) => page.lines.includes(line));
    const page = this.laidOut.pages[pageIndex];
    const pageElement = this.pagesHost.querySelector<HTMLElement>(
      '.writer__page[data-page="' + pageIndex + '"]',
    );
    if (!page || !pageElement) return;

    // Width of the text before the caret on this line.
    let x = 0;
    let consumed = line.start;
    for (const run of line.runs) {
      const runEnd = consumed + run.text.length;
      if (this.caret.offset >= runEnd) {
        x += run.width;
        consumed = runEnd;
        continue;
      }
      const within = this.caret.offset - consumed;
      x += run.width * (within / Math.max(1, run.text.length));
      break;
    }

    const box = pageElement.getBoundingClientRect();
    const hostBox = this.pagesHost.getBoundingClientRect();
    this.caretElement.style.insetInlineStart =
      box.left - hostBox.left + (page.marginLeft + x) * PT_TO_PX + 'px';
    this.caretElement.style.insetBlockStart =
      box.top - hostBox.top + (page.marginTop + line.y) * PT_TO_PX + 'px';
    this.caretElement.style.blockSize = line.height * PT_TO_PX + 'px';
  }

  focus(): void {
    this.input.focus();
  }

  currentDocument(): TextDocument {
    return this.document;
  }
}

/**
 * Markdown prefixes.
 *
 * A numbered list is written as "1." for every item, which is valid
 * Markdown: renderers number the list themselves. Writing the real index
 * would look tidier in the source and produce wrong numbers the moment an
 * item is inserted.
 */
function markdownPrefix(kind: BlockKind): string {
  switch (kind) {
    case 'heading1':
      return '# ';
    case 'heading2':
      return '## ';
    case 'heading3':
      return '### ';
    case 'bulleted':
      return '- ';
    case 'numbered':
      return '1. ';
    case 'quote':
      return '> ';
    default:
      return '';
  }
}

/**
 * A run, with its marks.
 *
 * Underline has no Markdown representation at all, which is why it is
 * declared as a loss rather than approximated with something that renders
 * as emphasis and means something else.
 */
function markdownRun(run: Run): string {
  let text = run.text;
  if (text.length === 0) return text;
  if (run.formatting.strikethrough === true) text = '~~' + text + '~~';
  if (run.formatting.italic === true) text = '*' + text + '*';
  if (run.formatting.bold === true) text = '**' + text + '**';
  return text;
}
