/**
 * The right-click menu, for every rendered element.
 *
 * One component, opened by delegation from the shell root, so a menu exists on
 * every element by construction rather than on the elements somebody
 * remembered. A per-surface menu would have been a menu that is missing
 * wherever the surface is newest.
 *
 * WHAT THIS CARRIES THAT AN ORDINARY MENU DOES NOT.
 *
 * Its own search field with its own anchored regular-expression builder, like
 * every other search surface here. "It only has four items" is not an
 * exemption: a four-item menu grows to fourteen without anybody revisiting the
 * decision, and a user who has learned to type in one menu and finds the next
 * one inert has learned that the pattern is unreliable.
 *
 * Every item shows the keyboard shortcut that ACTUALLY works in that context,
 * taken from the item rather than inferred, because a shortcut shown and not
 * bound trains somebody to press a key that does nothing.
 *
 * Filtering never changes what an item does and never hides a destructive item
 * into invisibility while leaving its shortcut live.
 */

import { el } from '../dom.js';
import { Overlay } from './overlay.js';
import { SearchField, type SearchPredicate } from './search-field.js';

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  /** Shown right-aligned, in the platform's notation. Omitted when there is none. */
  readonly shortcut?: string;
  /** Why the item cannot be used right now. Shown; the item stays visible. */
  readonly disabledReason?: string;
  readonly destructive?: boolean;
  readonly run: () => void;
}

export interface ContextMenuOptions {
  readonly anchor: HTMLElement;
  /** Names what the menu is for, so a screen reader says which element. */
  readonly label: string;
  readonly items: readonly MenuItem[];
  readonly onClose?: () => void;
}

export class ContextMenu {
  private readonly overlay: Overlay;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly search: SearchField;
  private readonly body: HTMLElement;
  private predicate: SearchPredicate | null = null;

  constructor(private readonly options: ContextMenuOptions) {
    this.list = el('div', {
      class: 'context-menu__list',
      role: 'menu',
      'aria-label': options.label,
    });

    this.empty = el('p', {
      class: 'context-menu__empty',
      role: 'status',
      hidden: true,
      // An honest no-match message, never a blank surface: a menu that empties
      // itself silently is indistinguishable from one that broke.
      text: 'Nothing in this menu matches.',
    });

    this.search = new SearchField({
      id: 'context-menu-search',
      label: 'Filter this menu',
      placeholder: 'Filter',
      onChange: (predicate) => {
        this.predicate = predicate;
        this.renderItems();
      },
    });

    this.overlay = new Overlay({
      anchor: options.anchor,
      label: options.label,
      ...(options.onClose === undefined ? {} : { onClose: options.onClose }),
    });

    this.overlay.element.classList.add('context-menu');
    this.body = el('div', { class: 'context-menu__body' }, [
      this.search.element,
      this.list,
      this.empty,
    ]);
    this.renderItems();

    this.list.addEventListener('keydown', (event) => this.onKeyDown(event));
  }

  open(): void {
    this.overlay.show(this.body);
    // Focus lands in the filter, so typing filters rather than being swallowed.
    // The arrow keys still walk the items from here.
    this.search.focus();
  }

  close(): void {
    this.overlay.close();
  }

  /** The items that survive the current filter, in their original order. */
  private visible(): readonly MenuItem[] {
    const predicate = this.predicate;
    if (predicate === null || predicate.empty || predicate.test === null) {
      // An invalid pattern matches NOTHING rather than falling back to plain
      // text, exactly as every other search here. A silent fallback returns
      // results the user did not ask for.
      if (predicate !== null && !predicate.empty && predicate.test === null) return [];
      return this.options.items;
    }
    const test = predicate.test;
    // Filtering never reorders. An order that changes under a filter changes
    // which item sits under the pointer, which is how somebody clicks the one
    // beside the one they read.
    return this.options.items.filter((item) => test(item.label));
  }

  private renderItems(): void {
    while (this.list.firstChild) this.list.firstChild.remove();

    const items = this.visible();
    this.empty.hidden = items.length > 0;

    for (const item of items) {
      const disabled = item.disabledReason !== undefined;
      const button = el(
        'button',
        {
          class: 'context-menu__item',
          type: 'button',
          role: 'menuitem',
          'data-item': item.id,
          'data-destructive': item.destructive === true ? 'true' : 'false',
          tabindex: -1,
          ...(disabled
            ? {
                disabled: true,
                // The exact unmet condition, on the control itself. A disabled
                // item with no explanation reads as broken rather than blocked.
                'aria-describedby': 'context-menu-reason-' + item.id,
                title: item.disabledReason,
              }
            : {}),
        },
        [
          el('span', { class: 'context-menu__label' }, [item.label]),
          item.shortcut === undefined
            ? null
            : el(
                'kbd',
                {
                  class: 'context-menu__shortcut',
                  // Announced as the shortcut rather than as loose text beside
                  // the label, so it is not read twice.
                  'aria-label': 'Shortcut ' + item.shortcut,
                },
                [item.shortcut],
              ),
        ],
      );

      if (!disabled) {
        button.addEventListener('click', () => {
          this.close();
          item.run();
        });
      }

      this.list.append(button);
      if (disabled) {
        this.list.append(
          el(
            'p',
            { class: 'context-menu__reason', id: 'context-menu-reason-' + item.id },
            [item.disabledReason ?? ''],
          ),
        );
      }
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    const buttons = [...this.list.querySelectorAll<HTMLButtonElement>('.context-menu__item')];
    if (buttons.length === 0) return;

    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = (current + step + buttons.length) % buttons.length;
      buttons[next]?.focus();
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      (event.key === 'Home' ? buttons[0] : buttons[buttons.length - 1])?.focus();
    }
  }

  /** Move focus from the filter into the list, for the first arrow press. */
  focusFirstItem(): void {
    this.list.querySelector<HTMLButtonElement>('.context-menu__item')?.focus();
  }
}
