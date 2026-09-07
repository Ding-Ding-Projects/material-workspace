/**
 * What the command palette can find.
 *
 * Everything the palette lists registers HERE, from the surface that owns it.
 * That ordering matters: a palette with its own hand-maintained copy of every
 * command drifts from the real surfaces the first time somebody renames one, and
 * the drift is silent because the palette entry still exists and still looks
 * right.
 *
 * Three kinds of entry, and the difference is not cosmetic:
 *
 *   command      does something
 *   destination  goes somewhere
 *   setting      IS the control — the palette renders the live switch, stepper,
 *                slider or field inline, wired to the same code as the settings
 *                surface. Somebody who can see a value has usually come to
 *                change it, and sending them elsewhere to do that is a round
 *                trip the interface could have saved.
 */

import type { Message } from '../../i18n.js';

export type EntryKind = 'command' | 'destination' | 'setting';

export interface BaseEntry {
  id: string;
  kind: EntryKind;
  /** Shown as the row title. */
  title: Message;
  /** Where this lives, shown as breadcrumb context. */
  group: Message;
  /** Extra words to match on, so a user's own vocabulary finds the row.
   *  Never rendered; purely for search. */
  keywords?: string[];
}

export interface CommandEntry extends BaseEntry {
  kind: 'command';
  run: () => void | Promise<void>;
  /** The keyboard shortcut that ACTUALLY works in this context, or null.
   *  Never one inferred from a similar command: a wrong shortcut trains a user
   *  to press a key that does nothing. */
  shortcut?: string | null;
}

export interface DestinationEntry extends BaseEntry {
  kind: 'destination';
  /**
   * Teleport to the exact element: open the owning surface, select the tab,
   * reveal the element, scroll it into view, focus it, and highlight it briefly.
   * Landing on a general page and leaving the user to hunt does not satisfy
   * this, so the contract returns the element it actually reached.
   */
  reveal: () => HTMLElement | null;
}

export type SettingControl =
  | { type: 'switch'; get: () => boolean; set: (value: boolean) => void }
  | {
      type: 'stepper';
      get: () => number;
      set: (value: number) => void;
      min: number;
      max: number;
      step: number;
    }
  | {
      type: 'choice';
      get: () => string;
      set: (value: string) => void;
      options: { value: string; label: Message }[];
    }
  | { type: 'text'; get: () => string; set: (value: string) => void; placeholder?: string };

export interface SettingEntry extends BaseEntry {
  kind: 'setting';
  /** Dotted settings path, used for reset and for provenance. */
  path: string;
  control: SettingControl;
  /** 'written' when somebody actually set this, 'default' when it is a
   *  compiled-in fallback. Displayed, because a value and where it came from
   *  are different facts. */
  provenance: () => 'written' | 'default';
  reset: () => void;
}

export type PaletteEntry = CommandEntry | DestinationEntry | SettingEntry;

/**
 * The registry.
 *
 * Deliberately a real list rather than a discovery scan. A scan that guesses
 * which elements are "settings" stops matching the day somebody renames a class,
 * and a palette that silently stops finding half the product is worse than one
 * that never found it.
 */
export class PaletteRegistry {
  private readonly entries = new Map<string, PaletteEntry>();
  private readonly listeners = new Set<() => void>();

  register(entry: PaletteEntry): () => void {
    if (this.entries.has(entry.id)) {
      // A duplicate id means one of the two is unreachable, and which one is
      // arbitrary. Loud, because silent shadowing is the harder bug.
      throw new Error(
        'a palette entry with the id "' +
          entry.id +
          '" is already registered. Ids must be unique or one of them can never be reached.',
      );
    }
    this.entries.set(entry.id, entry);
    this.notify();
    return () => {
      this.entries.delete(entry.id);
      this.notify();
    };
  }

  registerAll(entries: PaletteEntry[]): () => void {
    const undos = entries.map((entry) => this.register(entry));
    return () => {
      for (const undo of undos) undo();
    };
  }

  all(): PaletteEntry[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** One registry per window. */
export const paletteRegistry = new PaletteRegistry();

/**
 * Reveal an element the way the palette promises: scroll it into view, focus it
 * if it can take focus, and highlight it briefly so the eye lands on it.
 *
 * The highlight is removed on a timer AND on the next interaction, so a user who
 * clicks away does not leave a stray outline behind.
 */
export function revealElement(element: HTMLElement): HTMLElement {
  element.scrollIntoView({ block: 'center', behavior: 'auto' });

  const focusable =
    element.matches('input, button, select, textarea, a[href], [tabindex]') ||
    element.tabIndex >= 0;
  if (focusable) {
    element.focus({ preventScroll: true });
  } else {
    // Make it focusable just long enough to land on it, then put it back.
    const previous = element.getAttribute('tabindex');
    element.setAttribute('tabindex', '-1');
    element.focus({ preventScroll: true });
    element.addEventListener(
      'blur',
      () => {
        if (previous === null) element.removeAttribute('tabindex');
        else element.setAttribute('tabindex', previous);
      },
      { once: true },
    );
  }

  element.setAttribute('data-palette-revealed', 'true');
  const clear = (): void => element.removeAttribute('data-palette-revealed');
  window.setTimeout(clear, 2000);
  window.addEventListener('pointerdown', clear, { once: true });
  return element;
}
