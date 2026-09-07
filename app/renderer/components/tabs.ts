/**
 * Browser-style tabbed navigation.
 *
 * The strip docks to any edge and defaults to the LEFT. That default is
 * deliberate rather than contrarian: a screen is wider than it is tall while a
 * tab label is wider than it is high, so a vertical strip shows more tabs
 * legibly than the horizontal one every browser has trained people to expect.
 *
 * Docking is an ORIENTATION change, not a rotation. The things most easily got
 * wrong when the axis changes:
 *
 *   - `aria-orientation` follows the axis, not the markup. Getting this wrong
 *     produces a strip that looks correct and is unusable by keyboard, which no
 *     capture will ever reveal.
 *   - The arrow keys that move between tabs become up and down.
 *   - Overflow measures height rather than width, which is genuinely different
 *     arithmetic.
 *   - Labels are NEVER rotated ninety degrees. A sideways word is a word nobody
 *     reads.
 */

import { clear, el } from '../dom.js';
import type { TabEdge } from '../../shared/settings.js';

export interface TabDefinition {
  id: string;
  label: string;
  /** Both languages, for search, regardless of the active mode. */
  searchText: string;
  icon: string;
  /**
   * True when the panel should fill the available height and manage its own
   * scrolling, rather than growing to fit its content.
   *
   * Opt-in per tab rather than a blanket rule: a document editor wants its
   * toolbar and status line pinned while only the pages scroll, whereas an
   * ordinary page wants to grow and let the workspace scroll normally.
   */
  fills?: boolean;
  /** Built on first activation and kept, so state survives switching away. */
  render: () => HTMLElement;
}

export interface TabsOptions {
  /**
   * Which strip this is.
   *
   * The docking rules apply to the MAIN strip only. Scoping them by variant
   * rather than by nesting is what stops a nested strip inheriting the main
   * one's vertical layout — and it avoids the specificity trap, where an
   * override written for the nested case loses to :root[data-tab-edge] and
   * silently does nothing.
   */
  variant?: 'main' | 'nested';
  edge: TabEdge;
  tabs: TabDefinition[];
  pinned?: string[];
  onActivate?: (id: string) => void;
}

export class TabStrip {
  readonly strip: HTMLElement;
  readonly panelHost: HTMLElement;

  private readonly options: TabsOptions;
  private readonly panels = new Map<string, HTMLElement>();
  private order: string[];
  private pinned: Set<string>;
  private activeId: string;
  private filter: ((text: string) => boolean) | null = null;

  constructor(options: TabsOptions) {
    this.options = options;
    this.order = options.tabs.map((tab) => tab.id);
    this.pinned = new Set(options.pinned ?? []);
    this.activeId = this.order[0] ?? '';

    this.strip = el('nav', {
      class: 'tab-strip',
      'data-strip': options.variant ?? 'nested',
    });
    this.panelHost = el('div', { class: 'workspace' });

    this.renderStrip();
    this.activate(this.activeId);
  }

  /** Filter the visible tabs. One of the four tab-discovery searches. */
  setFilter(test: ((text: string) => boolean) | null): void {
    this.filter = test;
    this.renderStrip();
  }

  setEdge(edge: TabEdge): void {
    this.options.edge = edge;
    this.renderStrip();
  }

  private isVertical(): boolean {
    return this.options.edge === 'left' || this.options.edge === 'right';
  }

  private visibleTabs(): TabDefinition[] {
    const byId = new Map(this.options.tabs.map((tab) => [tab.id, tab]));
    // Pinned first, in their own stable region, then the rest in order.
    const ordered = [
      ...this.order.filter((id) => this.pinned.has(id)),
      ...this.order.filter((id) => !this.pinned.has(id)),
    ];
    const tabs = ordered
      .map((id) => byId.get(id))
      .filter((tab): tab is TabDefinition => tab !== undefined);
    if (!this.filter) return tabs;
    const test = this.filter;
    // A pinned tab stays visible: pinning means "keep this reachable", and a
    // filter that hides it defeats the point of having pinned it.
    return tabs.filter((tab) => this.pinned.has(tab.id) || test(tab.searchText));
  }

  private renderStrip(): void {
    clear(this.strip);
    this.strip.setAttribute('role', 'tablist');
    // Orientation follows the axis, so the arrow keys announced to assistive
    // technology are the ones that actually move between tabs.
    this.strip.setAttribute('aria-orientation', this.isVertical() ? 'vertical' : 'horizontal');
    this.strip.setAttribute('aria-label', 'Workspace sections');

    for (const tab of this.visibleTabs()) {
      const selected = tab.id === this.activeId;
      const button = el('button', {
        class: 'tab',
        type: 'button',
        role: 'tab',
        id: 'tab-' + tab.id,
        'data-tab': tab.id,
        'aria-selected': String(selected),
        'aria-controls': 'panel-' + tab.id,
        // Roving tabindex: only the selected tab is in the tab order, so a
        // keyboard user tabs INTO the strip once and then arrows within it.
        tabindex: selected ? '0' : '-1',
      });
      button.append(
        el('span', { class: 'tab__icon', 'aria-hidden': 'true', text: tab.icon }),
        el('span', { class: 'tab__label', text: tab.label }),
      );
      if (this.pinned.has(tab.id)) {
        button.append(el('span', { class: 'tab__pin', 'aria-hidden': 'true', text: '📌' }));
        // Pinned state reaches assistive technology as words, not as an emoji.
        button.setAttribute('aria-description', 'Pinned');
      }
      button.addEventListener('click', () => this.activate(tab.id));
      button.addEventListener('keydown', (event) => this.onStripKeyDown(event, tab.id));
      this.strip.append(button);
    }

    if (this.visibleTabs().length === 0) {
      this.strip.append(
        el('p', { class: 'tab-strip__empty', role: 'status', text: 'No section matches.' }),
      );
    }
  }

  private onStripKeyDown(event: KeyboardEvent, id: string): void {
    const vertical = this.isVertical();
    const next = vertical ? 'ArrowDown' : 'ArrowRight';
    const previous = vertical ? 'ArrowUp' : 'ArrowLeft';

    const tabs = this.visibleTabs();
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;

    let target: number | null = null;
    if (event.key === next) target = (index + 1) % tabs.length;
    else if (event.key === previous) target = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = tabs.length - 1;

    if (target === null) return;
    event.preventDefault();
    const targetTab = tabs[target];
    if (!targetTab) return;
    this.activate(targetTab.id);
    this.strip.querySelector<HTMLElement>('[data-tab="' + targetTab.id + '"]')?.focus();
  }

  activate(id: string): void {
    const definition = this.options.tabs.find((tab) => tab.id === id);
    if (!definition) return;
    this.activeId = id;

    // Built once and kept, so a tab's state survives switching away and back.
    let panel = this.panels.get(id);
    if (!panel) {
      panel = el('div', {
        class: 'tab-panel',
        role: 'tabpanel',
        id: 'panel-' + id,
        'aria-labelledby': 'tab-' + id,
        'data-fills': definition.fills ? 'true' : 'false',
        tabindex: '0',
      });
      panel.append(definition.render());
      this.panels.set(id, panel);
    }

    clear(this.panelHost);
    this.panelHost.append(panel);
    this.renderStrip();
    this.options.onActivate?.(id);
  }

  get active(): string {
    return this.activeId;
  }

  togglePin(id: string): void {
    if (this.pinned.has(id)) this.pinned.delete(id);
    else this.pinned.add(id);
    this.renderStrip();
  }

  /**
   * Every tab this strip knows about, filtered or not.
   *
   * Deliberately NOT `visibleTabs()`: the four searches must see a tab that is
   * currently filtered out or sitting in a collapsed group, or the master
   * search would only ever find what is already on screen - which is precisely
   * the tab nobody needs help finding.
   */
  definitions(): TabDefinition[] {
    return [...this.options.tabs];
  }

  get pinnedIds(): string[] {
    return [...this.pinned];
  }
}
