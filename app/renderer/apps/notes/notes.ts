/**
 * Notes.
 *
 * Three panes: the list, the editor, and what links here. The third is the one
 * that makes a pile of notes into something navigable, and it is the one most
 * note applications leave out.
 *
 * Search runs over the whole collection on every keystroke. That is affordable
 * because a note is plain text and the matcher is built once per query rather
 * than once per note — the naive shape compiles a regular expression inside
 * the loop and gets slow at a few hundred notes, which is exactly where people
 * start relying on search.
 */

import { clear, el } from '../../dom.js';
import {
  EMPTY as NO_SELECTION,
  type Selection,
  clear as clearSelection,
  describePlan,
  extend,
  invert,
  plan,
  selectAll,
  toggle,
} from '../../../shared/bulk.js';
import {
  type Note,
  type NoteCollection,
  type SortOrder,
  backlinks,
  displayTitle,
  emptyCollection,
  extractTags,
  newNote,
  searchNotes,
  sortNotes,
  tagCounts,
  unresolvedLinks,
  wordCount,
} from '../../../engines/notes/model.js';

export interface NotesOptions {
  collection?: NoteCollection;
  onChange?: (collection: NoteCollection) => void;
  /** Injected so tests and the drive are not at the mercy of the clock. */
  now?: () => Date;
}

export class Notes {
  readonly element: HTMLElement;

  private collection: NoteCollection;
  private readonly options: NotesOptions;
  private readonly now: () => Date;

  private selected: string | null = null;
  /**
   * The bulk selection, kept apart from `selected`.
   *
   * `selected` is the note being EDITED; this is the set an action applies to.
   * Conflating them means deleting a selection also changes what is on screen
   * mid-action, and the editor jumps to something the person never chose.
   */
  private marked: Selection = NO_SELECTION;
  private query = '';
  private useRegex = false;
  private tagFilter: string | null = null;
  private order: SortOrder = 'updated';

  private readonly searchInput: HTMLInputElement;
  private readonly regexToggle: HTMLInputElement;
  private readonly orderSelect: HTMLSelectElement;
  private readonly tagBar: HTMLElement;
  private readonly list: HTMLElement;
  private readonly editor: HTMLTextAreaElement;
  private readonly titleInput: HTMLInputElement;
  private readonly linksPanel: HTMLElement;
  private readonly statusLine: HTMLElement;
  private readonly toolbar: HTMLElement;

  constructor(options: NotesOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.collection = options.collection ?? emptyCollection();

    this.searchInput = el('input', {
      class: 'notes__search',
      type: 'search',
      'aria-label': 'Search notes',
      placeholder: 'Search titles, bodies and tags',
    }) as HTMLInputElement;

    this.regexToggle = el('input', {
      class: 'notes__regex',
      type: 'checkbox',
      id: 'notes-regex',
    }) as HTMLInputElement;

    this.orderSelect = el('select', {
      class: 'notes__order',
      'aria-label': 'Sort order',
    }) as HTMLSelectElement;
    for (const [value, label] of [
      ['updated', 'Recently changed'],
      ['created', 'Recently created'],
      ['title', 'By title'],
    ] as const) {
      this.orderSelect.append(el('option', { value, text: label }));
    }

    this.tagBar = el('div', { class: 'notes__tags', role: 'group', 'aria-label': 'Filter by tag' });
    this.list = el('div', { class: 'notes__list', role: 'listbox', 'aria-label': 'Notes' });

    this.titleInput = el('input', {
      class: 'notes__title',
      type: 'text',
      'aria-label': 'Note title',
      placeholder: 'Untitled note',
    }) as HTMLInputElement;

    this.editor = el('textarea', {
      class: 'notes__editor',
      'aria-label': 'Note body, in Markdown',
      placeholder: 'Markdown. #tags become filters, and [[double brackets]] link to another note.',
      spellcheck: 'true',
    }) as HTMLTextAreaElement;

    this.linksPanel = el('aside', {
      class: 'notes__links',
      'aria-label': 'Links to and from this note',
    });

    this.statusLine = el('div', {
      class: 'notes__status',
      role: 'status',
      'aria-live': 'polite',
    });

    this.toolbar = el('div', { class: 'notes__toolbar', role: 'toolbar', 'aria-label': 'Notes' }, [
      el('button', { class: 'notes__action', type: 'button', 'data-action': 'new' }, ['New note']),
      el('button', { class: 'notes__action', type: 'button', 'data-action': 'pin' }, ['Pin']),
      el('button', { class: 'notes__action', type: 'button', 'data-action': 'delete' }, ['Delete']),
      el('button', { class: 'notes__action', type: 'button', 'data-action': 'export' }, [
        'Export all as Markdown',
      ]),
      // Bulk actions, from the same model tabs, notifications and history use.
      // A second selection implementation per surface is a second set of edge
      // cases nobody tests.
      el('button', { class: 'notes__action', type: 'button', 'data-action': 'select-all' }, [
        'Select all',
      ]),
      el('button', { class: 'notes__action', type: 'button', 'data-action': 'invert' }, [
        'Invert',
      ]),
      el('button', { class: 'notes__action', type: 'button', 'data-action': 'delete-selected' }, [
        'Delete selected',
      ]),
    ]);

    this.element = el('div', { class: 'notes' }, [
      this.toolbar,
      el('div', { class: 'notes__search-bar' }, [
        this.searchInput,
        el('label', { class: 'notes__regex-label', for: 'notes-regex' }, [
          this.regexToggle,
          el('span', {}, ['Regular expression']),
        ]),
        this.orderSelect,
      ]),
      this.tagBar,
      el('div', { class: 'notes__body' }, [
        this.list,
        el('div', { class: 'notes__main' }, [this.titleInput, this.editor]),
        this.linksPanel,
      ]),
      this.statusLine,
    ]);

    this.wire();
    this.render();
  }

  /** The notes on screen, in order. Select-all covers what is SHOWN. */
  private visibleIds(): string[] {
    return [...this.list.querySelectorAll('.notes__item')]
      .map((node) => node.getAttribute('data-note') ?? '')
      .filter((id) => id !== '');
  }

  /**
   * Say what happened, ADDITIVELY.
   *
   * The status line is rebuilt from the counts on every render, so writing to
   * it directly meant the sentence about what a bulk action kept and why was
   * overwritten the instant the render ran - a person deleting four notes and
   * keeping two pinned ones was never told about the two. It is held here and
   * folded into the line instead.
   */
  private announce(message: string): void {
    this.note = message;
    this.renderStatus();
  }

  /** A one-off sentence to fold into the next status line. */
  private note = '';

  private wire(): void {
    this.searchInput.addEventListener('input', () => {
      this.query = this.searchInput.value;
      this.renderList();
      this.renderStatus();
    });

    this.regexToggle.addEventListener('change', () => {
      this.useRegex = this.regexToggle.checked;
      this.renderList();
      this.renderStatus();
    });

    this.orderSelect.addEventListener('change', () => {
      this.order = this.orderSelect.value as SortOrder;
      this.renderList();
    });

    this.list.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('.notes__item');
      const pointer = event as MouseEvent;
      if (target !== null && (pointer.ctrlKey || pointer.metaKey || pointer.shiftKey)) {
        // A modified click adjusts the BULK selection and leaves the editor
        // where it is. Opening a note somebody was only adding to a batch
        // would throw away whatever they were reading.
        const id = target.getAttribute('data-note') ?? '';
        this.marked = pointer.shiftKey
          ? extend(this.marked, id, this.visibleIds())
          : toggle(this.marked, id);
        this.render();
        return;
      }
      if (!target) return;
      this.selected = target.getAttribute('data-note');
      this.render();
    });

    this.tagBar.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('.notes__tag');
      if (!target) return;
      const tag = target.getAttribute('data-tag');
      // Clicking the active tag clears the filter, so there is always a way
      // back without hunting for a separate "clear" control.
      this.tagFilter = this.tagFilter === tag ? null : tag;
      this.render();
    });

    this.toolbar.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('.notes__action');
      if (!target) return;
      this.runAction(target.getAttribute('data-action') ?? '');
    });

    this.titleInput.addEventListener('input', () => {
      this.updateSelected((note) => ({ ...note, title: this.titleInput.value }));
      // Not a full render: rebuilding under a focused input moves the caret.
      this.renderList();
      this.renderStatus();
    });

    this.editor.addEventListener('input', () => {
      const body = this.editor.value;
      this.updateSelected((note) => ({ ...note, body, tags: extractTags(body) }));
      this.renderList();
      this.renderTagBar();
      this.renderLinks();
      this.renderStatus();
      // Only the placeholder, not the whole editor. A full renderEditor here
      // would rewrite the textarea's value under a caret that is mid-word;
      // setting a placeholder cannot move anything.
      const note = this.current();
      if (note !== undefined) this.titleInput.placeholder = displayTitle(note);
    });

    // A link in the panel opens the note it names, creating it when it does
    // not exist yet — which is the normal way a second note comes into being.
    this.linksPanel.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('.notes__link');
      if (!target) return;
      const title = target.getAttribute('data-link') ?? '';
      const existing = this.collection.notes.find(
        (note) => displayTitle(note).toLowerCase() === title.toLowerCase(),
      );
      if (existing !== undefined) {
        this.selected = existing.id;
      } else {
        const created = newNote(this.now().toISOString(), title);
        this.collection = { ...this.collection, notes: [...this.collection.notes, created] };
        this.selected = created.id;
        this.options.onChange?.(this.collection);
      }
      this.render();
    });
  }

  private runAction(action: string): void {
    switch (action) {
      case 'new': {
        const created = newNote(this.now().toISOString());
        this.collection = { ...this.collection, notes: [...this.collection.notes, created] };
        this.selected = created.id;
        break;
      }
      case 'pin': {
        this.updateSelected((note) => ({ ...note, pinned: !note.pinned }));
        break;
      }
      case 'select-all': {
        this.note = '';
        this.marked = selectAll(this.visibleIds());
        this.render();
        return;
      }
      case 'invert': {
        this.marked = invert(this.marked, this.visibleIds());
        this.render();
        return;
      }
      case 'delete-selected': {
        // Planned first, so a pinned note is KEPT and named rather than
        // silently skipped - a bulk delete that quietly drops items is
        // indistinguishable from one that failed.
        const outcome = plan(
          this.collection.notes.map((note) => ({ id: note.id, note })),
          this.marked,
          { protect: (entry) => (entry.note.pinned ? 'pinned' : null), irreversible: true },
        );
        if (outcome.acting.length === 0) {
          this.announce(describePlan(outcome, 'deleted'));
          return;
        }
        const going = new Set(outcome.acting.map((entry) => entry.id));
        const remaining = this.collection.notes.filter((note) => !going.has(note.id));
        this.collection = { ...this.collection, notes: remaining };
        if (this.selected !== null && going.has(this.selected)) {
          this.selected = remaining[0]?.id ?? null;
        }
        this.marked = clearSelection();
        this.announce(describePlan(outcome, 'deleted'));
        break;
      }
      case 'delete': {
        if (this.selected === null) return;
        const remaining = this.collection.notes.filter((note) => note.id !== this.selected);
        this.collection = { ...this.collection, notes: remaining };
        this.selected = remaining[0]?.id ?? null;
        break;
      }
      case 'export': {
        this.exportAll();
        return;
      }
      default:
        return;
    }
    this.options.onChange?.(this.collection);
    this.render();
  }

  /**
   * Every note as one Markdown file.
   *
   * With its own front matter, so a round trip through another editor keeps
   * the tags and the pinned state rather than silently discarding them.
   */
  private exportAll(): void {
    if (this.collection.notes.length === 0) {
      this.setStatus('Nothing to export yet.');
      return;
    }

    const parts: string[] = [];
    for (const note of sortNotes(this.collection.notes, 'created')) {
      parts.push(
        '---',
        'title: ' + displayTitle(note),
        'created: ' + note.createdAt,
        'updated: ' + note.updatedAt,
        'tags: ' + note.tags.join(', '),
        'pinned: ' + (note.pinned ? 'true' : 'false'),
        '---',
        '',
        note.body,
        '',
      );
    }

    const blob = new Blob([parts.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = el('a', { href: url, download: 'notes.md' }) as HTMLAnchorElement;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    this.setStatus(
      'Exported ' +
        this.collection.notes.length +
        ' notes as Markdown, with tags and pinned state in front matter. Nothing was lost.',
    );
  }

  private updateSelected(change: (note: Note) => Note): void {
    if (this.selected === null) return;
    const at = this.now().toISOString();
    this.collection = {
      ...this.collection,
      notes: this.collection.notes.map((note) =>
        note.id === this.selected ? { ...change(note), updatedAt: at } : note,
      ),
    };
    this.options.onChange?.(this.collection);
  }

  private current(): Note | undefined {
    return this.collection.notes.find((note) => note.id === this.selected);
  }

  // ------------------------------------------------------------- rendering --

  private render(): void {
    this.renderList();
    this.renderTagBar();
    this.renderEditor();
    this.renderLinks();
    this.renderStatus();
  }

  private renderList(): void {
    clear(this.list);

    const results = searchNotes(this.collection, {
      query: this.query,
      useRegex: this.useRegex,
      ...(this.tagFilter === null ? {} : { tag: this.tagFilter }),
    });
    const ordered = sortNotes(
      results.map((result) => result.note),
      this.order,
    );
    const excerpts = new Map(results.map((result) => [result.note.id, result.excerpt]));

    if (ordered.length === 0) {
      // An honest empty state, distinguishing "no notes yet" from "nothing
      // matched" — they need different actions from the user.
      this.list.append(
        el('p', { class: 'notes__empty' }, [
          this.collection.notes.length === 0
            ? 'No notes yet. Choose New note to write one.'
            : 'No note matches that search.',
        ]),
      );
      return;
    }

    for (const note of ordered) {
      this.list.append(
        el(
          'div',
          {
            class: 'notes__item',
            // The mark is an attribute AND aria-pressed, never a tint alone:
            // a background colour says nothing to a screen reader.
            'data-marked': this.marked.chosen.has(note.id) ? 'yes' : 'no',
            'aria-pressed': String(this.marked.chosen.has(note.id)),
            role: 'option',
            'data-note': note.id,
            'data-current': note.id === this.selected ? 'true' : 'false',
            'aria-selected': note.id === this.selected ? 'true' : 'false',
          },
          [
            el('span', { class: 'notes__item-title' }, [
              // Pinned is stated in text as well as shown, because a pin icon
              // alone is invisible to a screen reader.
              ...(note.pinned ? [el('span', { class: 'notes__pin' }, ['Pinned'])] : []),
              displayTitle(note),
            ]),
            el('span', { class: 'notes__item-excerpt' }, [excerpts.get(note.id) ?? '']),
          ],
        ),
      );
    }
  }

  private renderTagBar(): void {
    clear(this.tagBar);
    const counts = tagCounts(this.collection);
    if (counts.length === 0) return;

    for (const { tag, count } of counts) {
      this.tagBar.append(
        el(
          'button',
          {
            class: 'notes__tag',
            type: 'button',
            'data-tag': tag,
            'data-active': this.tagFilter === tag ? 'true' : 'false',
            'aria-pressed': this.tagFilter === tag ? 'true' : 'false',
          },
          ['#' + tag + ' ' + count],
        ),
      );
    }
  }

  private renderEditor(): void {
    const note = this.current();
    const present = note !== undefined;
    this.titleInput.disabled = !present;
    this.editor.disabled = !present;

    if (!present) {
      this.titleInput.value = '';
      this.titleInput.placeholder = 'Untitled note';
      this.editor.value = '';
      return;
    }

    // The placeholder shows the DERIVED title, so the box and the list agree.
    //
    // A note whose title comes from its first heading has an empty title
    // field, and a fixed "Untitled note" placeholder there while the list
    // plainly reads "Tea houses" looks like the two disagree about which note
    // is open.
    this.titleInput.placeholder = displayTitle(note);
    if (document.activeElement !== this.titleInput) this.titleInput.value = note.title;
    if (document.activeElement !== this.editor) this.editor.value = note.body;
  }

  private renderLinks(): void {
    clear(this.linksPanel);
    const note = this.current();
    if (note === undefined) return;

    const incoming = backlinks(this.collection, note);
    const missing = unresolvedLinks(this.collection, note);

    this.linksPanel.append(el('h3', {}, ['Links here']));
    if (incoming.length === 0) {
      this.linksPanel.append(el('p', { class: 'notes__empty' }, ['Nothing links here yet.']));
    } else {
      for (const source of incoming) {
        this.linksPanel.append(
          el(
            'button',
            { class: 'notes__link', type: 'button', 'data-link': displayTitle(source) },
            [displayTitle(source)],
          ),
        );
      }
    }

    if (missing.length > 0) {
      this.linksPanel.append(
        el('h3', {}, ['Not written yet']),
        // Not an error. A link to a note that does not exist is how the next
        // note gets created, so each one is a button that creates it.
        ...missing.map((title) =>
          el(
            'button',
            {
              class: 'notes__link notes__link--missing',
              type: 'button',
              'data-link': title,
              title: 'Create a note called ' + title,
            },
            [title],
          ),
        ),
      );
    }
  }

  private renderStatus(): void {
    const note = this.current();
    const total = this.collection.notes.length;
    const shown = this.list.querySelectorAll('.notes__item').length;

    const parts = [total + (total === 1 ? ' note' : ' notes')];
    // First, so it is read before the counts rather than after them.
    if (this.note !== '') parts.unshift(this.note);
    if (shown !== total) parts.push(shown + ' shown');
    if (this.tagFilter !== null) parts.push('filtered by #' + this.tagFilter);
    if (note !== undefined) {
      const words = wordCount(note.body);
      parts.push(words + (words === 1 ? ' word' : ' words'));
    }
    if (this.useRegex && this.query.trim().length > 0) {
      // A pattern that will not compile returns nothing rather than throwing,
      // so the field stays usable while it is being typed — but the user is
      // told, or an empty list looks like "no matches".
      let valid = true;
      try {
        new RegExp(this.query, 'iu');
      } catch {
        valid = false;
      }
      if (!valid) parts.push('the pattern is not valid yet');
    }

    this.setStatus(parts.join('   '));
  }

  private setStatus(message: string): void {
    clear(this.statusLine);
    this.statusLine.append(message);
  }
}
