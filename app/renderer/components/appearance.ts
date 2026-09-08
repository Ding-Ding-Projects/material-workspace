/**
 * Appearance.
 *
 * The colour picker's home, and the surface where the accent colour is
 * actually chosen rather than typed as a hex into a settings row.
 *
 * The picker writes to `appearance.seedColor`, which the shell already reads,
 * so there is one value rather than a second parallel one that drifts. A
 * feature wired at one end and consumed at neither ships silently, and this
 * This project has already met that once.
 */

import type { WorkspaceSettings } from '../../shared/settings.js';
import { RAINBOW, SPEED_LEVELS, durationFor, isRainbow, isSpeedLevel } from '../colour/rainbow.js';
import { clear, el } from '../dom.js';
import { ColourPicker } from './colour-picker.js';

export interface AppearanceOptions {
  readonly settings: WorkspaceSettings;
  readonly onPatch?: (patch: Partial<WorkspaceSettings>) => void;
  /** Injected so a test can assert a copy without a real clipboard. */
  readonly onCopy?: (text: string) => void;
}

export class Appearance {
  readonly element: HTMLElement;

  private readonly picker: ColourPicker;
  private readonly currentRow: HTMLElement;

  constructor(private readonly options: AppearanceOptions) {
    const appearance = options.settings.appearance;

    this.currentRow = el('p', { class: 'appearance-current', role: 'status' });

    this.picker = new ColourPicker({
      value: appearance.seedColor,
      // The contrast readout is against the surface this accent will actually
      // sit on, not against an assumed white. A ratio computed against the
      // wrong background is worse than none: it is confidently wrong in
      // exactly the theme where contrast problems live.
      against: appearance.theme === 'dark' ? '#101014' : '#ffffff',
      onChange: (value) => this.onColour(value),
      ...(options.onCopy === undefined ? {} : { onCopy: options.onCopy }),
    });

    this.element = el('section', { class: 'appearance', 'aria-label': 'Appearance' }, [
      el('header', { class: 'appearance-header' }, [
        el('h2', { class: 'appearance-title', text: 'Appearance' }),
        el('p', {
          class: 'appearance-lede',
          text:
            'The accent colour the whole application is built from. Every notation of it is ' +
            'below, so a colour that arrives written one way can leave written another.',
        }),
      ]),

      this.currentRow,
      this.picker.element,

      el('footer', { class: 'appearance-footer' }, [
        el('p', {
          class: 'appearance-note',
          text:
            'This surface changes the one accent colour. To restyle a single ' +
            'element, right-click it and choose Edit appearance - that editor ' +
            'carries the properties, the layer stack and saved styles. Importing ' +
            'and exporting a whole theme as a file is not wired to a control yet.',
        }),
      ]),
    ]);

    this.render();
  }

  /** The picker, for tests and for the shell. */
  colourPicker(): ColourPicker {
    return this.picker;
  }

  private onColour(value: string): void {
    const appearance = this.options.settings.appearance;
    const speed = isRainbow(value)
      ? // Kept in step so the stored level and what the surface shows cannot
        // disagree. An out-of-range level in a hand-edited file falls back
        // rather than reaching CSS as an invalid duration, which would
        // silently disable the animation instead of failing.
        isSpeedLevel(appearance.rainbowSpeedLevel)
        ? appearance.rainbowSpeedLevel
        : SPEED_LEVELS[2]
      : appearance.rainbowSpeedLevel;

    this.options.onPatch?.({
      appearance: { ...appearance, seedColor: value, rainbowSpeedLevel: speed },
    } as Partial<WorkspaceSettings>);

    this.render();
  }

  private render(): void {
    const value = this.picker.value();
    clear(this.currentRow);

    if (isRainbow(value)) {
      const level = this.options.settings.appearance.rainbowSpeedLevel;
      this.currentRow.append(
        el('span', { class: 'appearance-current-label', text: 'Accent: ' }),
        el('span', { class: 'appearance-current-value', text: 'cycling through the hues' }),
        el('span', {
          class: 'appearance-current-detail',
          text:
            ' — one full turn every ' + durationFor(level) + 's. With reduced motion turned ' +
            'on it settles on a single colour rather than slowing down, because a slow ' +
            'cycle is still motion.',
        }),
      );
      this.currentRow.dataset['rainbow'] = 'yes';
      return;
    }

    this.currentRow.dataset['rainbow'] = 'no';
    this.currentRow.append(
      el('span', { class: 'appearance-current-label', text: 'Accent: ' }),
      el('span', { class: 'appearance-current-value', text: value }),
    );
  }
}

/** Re-exported so a caller does not need to know where the sentinel lives. */
export { RAINBOW };
