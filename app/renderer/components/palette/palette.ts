/**
 * The command palette, on Ctrl+Shift+F.
 *
 * One discoverable global shortcut. Not Ctrl+K: that is claimed by too much else
 * and this project uses the single documented combination everywhere.
 *
 * The palette is not a list of shortcuts. It is the whole product, searchable:
 * every command, every destination, and every setting — and a setting row
 * renders its LIVE CONTROL inline, wired to the same code as the settings
 * surface, so the two can never disagree about what a value is or what changing
 * it does.
 *
 * Selecting a destination TELEPORTS: it opens the owning surface, reveals the
 * exact element, scrolls it into view, focuses it and highlights it. Landing on
 * a page and leaving the user to hunt does not satisfy that.
 */

import { clear, el } from '../../dom.js';
import type { I18n, Message } from '../../i18n.js';
import { SearchField, type SearchPredicate } from '../search-field.js';
import {
  paletteRegistry,
  revealElement,
  type PaletteEntry,
  type SettingEntry,
} from './registry.js';

export type PaletteSize = 'card' | 'full';

export interface PaletteOptions {
  i18n: I18n;
  /** Persisted across restarts; the bounded card is the shipped default. */
  initialSize?: PaletteSize;
  onSizeChange?: (size: PaletteSize) => void;
}

const MAX_RENDERED_ROWS = 300;

export class CommandPalette {
  private readonly options: PaletteOptions;
  private readonly i18n: I18n;

  private container: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private countRegion: HTMLElement | null = null;
  private search: SearchField | null = null;
  private predicate: SearchPredicate | null = null;
  private size: PaletteSize;
  private activeIndex = 0;
  private visible: PaletteEntry[] = [];
  private previousFocus: HTMLElement | null = null;
  private unregisterListener: (() => void) | null = null;

  constructor(options: PaletteOptions) {
    this.options = options;
    this.i18n = options.i18n;
    this.size = options.initialSize ?? 'card';
  }

  /** Install the global shortcut. Returns a teardown function. */
  install(): () => void {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Match on `code`, not `key`. With a non-US layout or a modifier applied,
      // `key` can be a different character entirely, and the shortcut then works
      // on the author's keyboard and nowhere else.
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyF') {
        event.preventDefault();
        this.toggle();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }

  get isOpen(): boolean {
    return this.container !== null;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    if (this.isOpen) return;
    this.previousFocus = document.activeElement as HTMLElement | null;

    const search = new SearchField({
      id: 'palette-search',
      label: 'Search commands, settings and destinations',
      placeholder: 'Search everything',
      onChange: (predicate) => {
        this.predicate = predicate;
        this.activeIndex = 0;
        this.renderList();
      },
    });
    this.search = search;

    this.list = el('div', {
      class: 'palette__list',
      role: 'listbox',
      id: 'palette-list',
      'aria-label': 'Results',
    });
    this.countRegion = el('p', {
      class: 'palette__count',
      role: 'status',
      'aria-live': 'polite',
    });

    const sizeToggle = el('button', {
      class: 'palette__size',
      type: 'button',
      'aria-label':
        this.size === 'card' ? 'Expand the palette to the full window' : 'Shrink the palette to a card',
    });
    sizeToggle.textContent = this.size === 'card' ? '⤢' : '⤡';
    sizeToggle.addEventListener('click', () => {
      this.size = this.size === 'card' ? 'full' : 'card';
      this.options.onSizeChange?.(this.size);
      this.container?.setAttribute('data-size', this.size);
      sizeToggle.textContent = this.size === 'card' ? '⤢' : '⤡';
      sizeToggle.setAttribute(
        'aria-label',
        this.size === 'card'
          ? 'Expand the palette to the full window'
          : 'Shrink the palette to a card',
      );
    });

    const panel = el(
      'div',
      {
        class: 'palette',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'Command palette',
        'data-size': this.size,
      },
      [
        el('div', { class: 'palette__header' }, [search.element, sizeToggle]),
        this.countRegion,
        this.list,
      ],
    );

    this.container = el('div', { class: 'palette__scrim' }, [panel]);
    this.container.addEventListener('pointerdown', (event) => {
      if (event.target === this.container) this.close();
    });
    document.body.append(this.container);

    // Rebuild if a surface registers or unregisters while the palette is open.
    this.unregisterListener = paletteRegistry.onChange(() => this.renderList());

    this.container.addEventListener('keydown', (event) => this.onKeyDown(event));

    this.renderList();
    search.focus();
  }

  close(): void {
    if (!this.container) return;
    this.unregisterListener?.();
    this.unregisterListener = null;
    this.container.remove();
    this.container = null;
    this.list = null;
    this.countRegion = null;
    this.search = null;
    this.predicate = null;
    // Focus returns where it came from, or the keyboard is stranded.
    this.previousFocus?.focus();
    this.previousFocus = null;
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const count = Math.min(this.visible.length, MAX_RENDERED_ROWS);
      if (count === 0) return;
      this.activeIndex = (this.activeIndex + delta + count) % count;
      this.updateActiveRow();
      return;
    }
    if (event.key === 'Enter') {
      // Enter inside a setting's own control adjusts that control; it must not
      // also activate the row.
      const target = event.target as HTMLElement | null;
      if (target && target.closest('.palette__control')) return;
      event.preventDefault();
      const entry = this.visible[this.activeIndex];
      if (entry) void this.activate(entry);
    }
  }

  private matchText(entry: PaletteEntry): string {
    // Both languages, always, so a Cantonese term finds its row while the
    // interface is in English and the other way round.
    return [
      this.i18n.english(entry.title),
      this.i18n.cantonese(entry.title),
      this.i18n.english(entry.group),
      this.i18n.cantonese(entry.group),
      entry.id,
      ...(entry.keywords ?? []),
    ].join(' ');
  }

  private renderList(): void {
    if (!this.list || !this.countRegion) return;
    clear(this.list);

    const all = paletteRegistry.all();
    const predicate = this.predicate;

    if (predicate && predicate.error) {
      this.countRegion.textContent =
        'That pattern will not compile, so nothing was matched: ' + predicate.error;
      this.visible = [];
      return;
    }

    this.visible =
      predicate && !predicate.empty && predicate.test
        ? all.filter((entry) => predicate.test?.(this.matchText(entry)) ?? false)
        : all;

    if (this.visible.length === 0) {
      this.countRegion.textContent = 'Nothing matches that search.';
      return;
    }

    const shown = Math.min(this.visible.length, MAX_RENDERED_ROWS);
    this.countRegion.textContent =
      shown === this.visible.length
        ? this.visible.length === 1
          ? '1 result'
          : this.visible.length + ' results'
        : 'Showing the first ' + shown + ' of ' + this.visible.length + ' results';

    for (const [index, entry] of this.visible.slice(0, MAX_RENDERED_ROWS).entries()) {
      this.list.append(this.renderRow(entry, index));
    }
    this.updateActiveRow();
  }

  private renderRow(entry: PaletteEntry, index: number): HTMLElement {
    const row = el('div', {
      class: 'palette__row',
      role: 'option',
      id: 'palette-row-' + index,
      'data-kind': entry.kind,
      'aria-selected': String(index === this.activeIndex),
      tabindex: '-1',
    });

    row.append(
      el('div', { class: 'palette__row-main' }, [
        el('span', { class: 'palette__row-title', text: this.i18n.t(entry.title) }),
        el('span', { class: 'palette__row-group', text: this.i18n.t(entry.group) }),
      ]),
    );

    if (entry.kind === 'setting') {
      row.append(this.renderSettingControl(entry));
    } else if (entry.kind === 'command' && entry.shortcut) {
      // The shortcut that actually works in this context, right-aligned, so a
      // command is learnable from the place people go looking for it.
      row.append(el('kbd', { class: 'palette__shortcut', text: entry.shortcut }));
    }

    row.addEventListener('click', (event) => {
      // A click on the inline control adjusts the setting; it must not also
      // teleport away from it.
      if ((event.target as HTMLElement).closest('.palette__control')) return;
      this.activeIndex = index;
      void this.activate(entry);
    });

    return row;
  }

  /**
   * A setting row IS the control.
   *
   * Wired to the same getter and setter as the settings surface, so two paths to
   * one value can never disagree.
   */
  private renderSettingControl(entry: SettingEntry): HTMLElement {
    const wrapper = el('div', { class: 'palette__control' });
    const control = entry.control;
    const controlId = 'palette-control-' + entry.id;

    if (control.type === 'switch') {
      const input = el('input', {
        type: 'checkbox',
        id: controlId,
        'aria-label': this.i18n.accessible(entry.title),
      }) as HTMLInputElement;
      input.checked = control.get();
      input.addEventListener('change', () => control.set(input.checked));
      wrapper.append(input);
    } else if (control.type === 'stepper') {
      const input = el('input', {
        type: 'number',
        id: controlId,
        min: String(control.min),
        max: String(control.max),
        step: String(control.step),
        'aria-label': this.i18n.accessible(entry.title),
      }) as HTMLInputElement;
      input.value = String(control.get());
      input.addEventListener('change', () => {
        const value = Number(input.value);
        if (Number.isFinite(value)) control.set(value);
      });
      wrapper.append(input);
    } else if (control.type === 'choice') {
      const select = el('select', {
        id: controlId,
        'aria-label': this.i18n.accessible(entry.title),
      }) as HTMLSelectElement;
      for (const option of control.options) {
        const node = el('option', { value: option.value, text: this.i18n.t(option.label) });
        select.append(node);
      }
      select.value = control.get();
      select.addEventListener('change', () => control.set(select.value));
      wrapper.append(select);
    } else {
      const input = el('input', {
        type: 'text',
        id: controlId,
        placeholder: control.placeholder ?? '',
        'aria-label': this.i18n.accessible(entry.title),
      }) as HTMLInputElement;
      input.value = control.get();
      input.addEventListener('change', () => control.set(input.value));
      wrapper.append(input);
    }

    // Provenance, because a value and where it came from are different facts.
    // "default" here means nobody set it and this is the compiled-in fallback.
    const provenance = entry.provenance();
    wrapper.append(
      el('span', {
        class: 'palette__provenance',
        'data-provenance': provenance,
        title:
          provenance === 'default'
            ? 'This is the value the application ships with. Nobody has changed it.'
            : 'This value was set and saved.',
        text: provenance === 'default' ? 'default' : 'set',
      }),
    );

    return wrapper;
  }

  private updateActiveRow(): void {
    if (!this.list) return;
    const rows = [...this.list.querySelectorAll<HTMLElement>('.palette__row')];
    rows.forEach((row, index) => {
      row.setAttribute('aria-selected', String(index === this.activeIndex));
    });
    const active = rows[this.activeIndex];
    if (active) {
      active.scrollIntoView({ block: 'nearest' });
      // The listbox keeps focus in the search field; the active row is
      // announced through aria-activedescendant so typing never stops working.
      this.list.setAttribute('aria-activedescendant', active.id);
    }
  }

  private async activate(entry: PaletteEntry): Promise<void> {
    if (entry.kind === 'command') {
      this.close();
      await entry.run();
      return;
    }
    if (entry.kind === 'destination') {
      this.close();
      const element = entry.reveal();
      if (element) revealElement(element);
      return;
    }
    // A setting row is operated in place. Closing the palette to change a
    // switch would undo the whole point of rendering the switch here.
  }
}
