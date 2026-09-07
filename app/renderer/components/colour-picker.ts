/**
 * The infinite colour picker.
 *
 * "Infinite" is the load-bearing word: a continuous two-dimensional field plus
 * numeric entry, never a grid of swatches. Swatches, recent colours and an
 * eyedropper are conveniences layered on top, not the thing itself. A chooser
 * that only offers a finite set is a chooser that cannot express the colour
 * somebody actually wants, and they will notice the first time they try.
 *
 * The translator beside it is the other half. Somebody arrives with a colour
 * in one notation and needs it in another, and doing that conversion by hand
 * is both tedious and the sort of thing people get subtly wrong.
 */

import {
  type Rgb,
  contrastRatio,
  contrastVerdict,
  hsvToRgb,
  isInSrgbGamut,
  parseHex,
  rgbToHsv,
  toHex,
} from '../colour/convert.js';
import { NON_CSS, format, parseAny, translate } from '../colour/notation.js';
import {
  DEFAULT_SPEED,
  RAINBOW,
  SPEED_LEVELS,
  type SpeedLevel,
  durationFor,
  isRainbow,
  isSpeedLevel,
  resolveForStatic,
  wheelStops,
} from '../colour/rainbow.js';
import { clear, el } from '../dom.js';

export interface ColourPickerOptions {
  /** The starting value: any parseable colour, or the rainbow sentinel. */
  readonly value?: string;
  /** What this colour will sit against, for the contrast readout. */
  readonly against?: string;
  readonly onChange?: (value: string) => void;
  /** Injected so a test can drive the field without a real pointer. */
  readonly onCopy?: (text: string) => void;
}

const FIELD_SIZE = 200;

export class ColourPicker {
  readonly element: HTMLElement;

  private rgb: Rgb = { r: 0x67, g: 0x50, b: 0xa4, alpha: 1 };
  private rainbow = false;
  private speed: SpeedLevel = DEFAULT_SPEED;
  private against: Rgb = { r: 255, g: 255, b: 255, alpha: 1 };
  private recents: string[] = [];

  private readonly field: HTMLElement;
  private readonly fieldThumb: HTMLElement;
  private readonly hueInput: HTMLInputElement;
  private readonly alphaInput: HTMLInputElement;
  private readonly preview: HTMLElement;
  private readonly entry: HTMLInputElement;
  private readonly entryError: HTMLElement;
  private readonly rows: HTMLElement;
  private readonly contrastRow: HTMLElement;
  private readonly gamutRow: HTMLElement;
  private readonly rainbowToggle: HTMLInputElement;
  private readonly speedRow: HTMLElement;
  private readonly speedInput: HTMLInputElement;
  private readonly recentRow: HTMLElement;

  constructor(private readonly options: ColourPickerOptions = {}) {
    if (options.value !== undefined) this.setValue(options.value, false);
    if (options.against !== undefined) {
      this.against = parseAny(options.against) ?? this.against;
    }

    this.fieldThumb = el('div', { class: 'picker-thumb', 'aria-hidden': 'true' });
    this.field = el(
      'div',
      {
        class: 'picker-field',
        role: 'application',
        tabindex: '0',
        'aria-label': 'Saturation and brightness. Arrow keys adjust; hold shift for larger steps.',
      },
      [this.fieldThumb],
    );
    this.field.addEventListener('pointerdown', (event) => this.onFieldPointer(event));
    this.field.addEventListener('keydown', (event) => this.onFieldKey(event));

    this.hueInput = el('input', {
      class: 'picker-slider picker-hue',
      type: 'range',
      min: '0',
      max: '360',
      step: '0.1',
      id: 'picker-hue',
      'aria-label': 'Hue in degrees',
    }) as HTMLInputElement;
    this.hueInput.addEventListener('input', () => this.onHue());

    this.alphaInput = el('input', {
      class: 'picker-slider picker-alpha',
      type: 'range',
      min: '0',
      max: '1',
      step: '0.001',
      id: 'picker-alpha',
      'aria-label': 'Opacity, from fully transparent to fully opaque',
    }) as HTMLInputElement;
    this.alphaInput.addEventListener('input', () => this.onAlpha());

    this.preview = el('div', { class: 'picker-preview' });

    this.entry = el('input', {
      class: 'picker-entry',
      type: 'text',
      id: 'picker-entry',
      spellcheck: 'false',
      'aria-describedby': 'picker-entry-help picker-entry-error',
    }) as HTMLInputElement;
    this.entry.addEventListener('change', () => this.onEntry());
    this.entryError = el('p', {
      class: 'picker-entry-error',
      id: 'picker-entry-error',
      role: 'alert',
      hidden: true,
    });

    this.rows = el('dl', { class: 'picker-translations' });
    this.contrastRow = el('p', { class: 'picker-contrast' });
    this.gamutRow = el('p', { class: 'picker-gamut', hidden: true });
    this.recentRow = el('div', { class: 'picker-recents', role: 'list' });

    this.rainbowToggle = el('input', {
      class: 'picker-rainbow-toggle',
      type: 'checkbox',
      id: 'picker-rainbow',
    }) as HTMLInputElement;
    this.rainbowToggle.addEventListener('change', () => this.onRainbow());

    this.speedInput = el('input', {
      class: 'picker-slider picker-speed',
      type: 'range',
      min: String(SPEED_LEVELS[0]),
      max: String(SPEED_LEVELS[SPEED_LEVELS.length - 1]),
      step: '1',
      id: 'picker-speed',
      'aria-label': 'Rainbow speed, 1 slowest to 5 fastest',
    }) as HTMLInputElement;
    this.speedInput.addEventListener('input', () => this.onSpeed());

    this.speedRow = el('div', { class: 'picker-speed-row', hidden: true }, [
      el('label', { class: 'picker-label', for: 'picker-speed', text: 'Rainbow speed' }),
      this.speedInput,
      el('span', { class: 'picker-speed-readout' }),
    ]);

    this.element = el('section', { class: 'picker', 'aria-label': 'Colour picker' }, [
      el('div', { class: 'picker-main' }, [
        el('div', { class: 'picker-field-column' }, [
          this.field,
          el('label', { class: 'picker-label', for: 'picker-hue', text: 'Hue' }),
          this.hueInput,
          el('label', { class: 'picker-label', for: 'picker-alpha', text: 'Opacity' }),
          this.alphaInput,
        ]),
        el('div', { class: 'picker-side' }, [
          this.preview,
          el('label', { class: 'picker-label', for: 'picker-entry', text: 'Enter a colour' }),
          this.entry,
          el('p', {
            class: 'picker-help',
            id: 'picker-entry-help',
            text: 'Any notation below is accepted, plus a name or a bare hex.',
          }),
          this.entryError,
          this.contrastRow,
          this.gamutRow,
          el('div', { class: 'picker-rainbow-row' }, [
            this.rainbowToggle,
            el('label', {
              class: 'picker-label',
              for: 'picker-rainbow',
              text: 'Cycle through the hues',
            }),
          ]),
          this.speedRow,
        ]),
      ]),

      el('h3', { class: 'picker-subtitle', text: 'The same colour, written every way' }),
      this.rows,

      el('h3', { class: 'picker-subtitle', text: 'Recent' }),
      this.recentRow,
    ]);

    this.render();
  }

  /** The stored value: a colour string, or the rainbow sentinel. */
  value(): string {
    return this.rainbow ? RAINBOW : toHex(this.rgb, this.rgb.alpha !== 1);
  }

  setValue(value: string, notify = true): boolean {
    if (isRainbow(value)) {
      this.rainbow = true;
      if (notify) this.emit();
      return true;
    }
    const parsed = parseAny(value);
    if (parsed === null) return false;
    this.rainbow = false;
    this.rgb = parsed;
    if (notify) this.emit();
    return true;
  }

  setAgainst(value: string): void {
    // Resolved first: a contrast ratio against the sentinel is meaningless,
    // and a static context has no time axis to sample the animation along.
    this.against = parseAny(resolveForStatic(value)) ?? this.against;
    this.render();
  }

  private emit(): void {
    this.render();
    this.options.onChange?.(this.value());
  }

  // ------------------------------------------------------------- controls --

  private onFieldPointer(event: PointerEvent): void {
    const box = this.field.getBoundingClientRect();
    const x = Math.min(Math.max(event.clientX - box.left, 0), box.width);
    const y = Math.min(Math.max(event.clientY - box.top, 0), box.height);
    const hsv = rgbToHsv(this.rgb);
    this.rgb = hsvToRgb({
      h: hsv.h,
      s: (x / Math.max(box.width, 1)) * 100,
      // Inverted: brightness increases upward, which is what every other
      // picker does and therefore what a hand expects.
      v: 100 - (y / Math.max(box.height, 1)) * 100,
      alpha: this.rgb.alpha,
    });
    this.leaveRainbow();
    this.emit();
  }

  /**
   * Keyboard control of the field.
   *
   * Not optional. A two-dimensional area driven only by a pointer is
   * unreachable for anybody who cannot use one, and the arrow keys are the
   * obvious mapping - so obvious that leaving them out reads as an oversight
   * rather than a decision.
   */
  private onFieldKey(event: KeyboardEvent): void {
    const step = event.shiftKey ? 10 : 1;
    const hsv = rgbToHsv(this.rgb);
    let { s, v } = hsv;

    switch (event.key) {
      case 'ArrowLeft': s -= step; break;
      case 'ArrowRight': s += step; break;
      case 'ArrowUp': v += step; break;
      case 'ArrowDown': v -= step; break;
      default: return;
    }
    event.preventDefault();

    this.rgb = hsvToRgb({
      h: hsv.h,
      s: Math.min(Math.max(s, 0), 100),
      v: Math.min(Math.max(v, 0), 100),
      alpha: this.rgb.alpha,
    });
    this.leaveRainbow();
    this.emit();
  }

  private onHue(): void {
    const hsv = rgbToHsv(this.rgb);
    this.rgb = hsvToRgb({ ...hsv, h: Number(this.hueInput.value), alpha: this.rgb.alpha });
    this.leaveRainbow();
    this.emit();
  }

  private onAlpha(): void {
    this.rgb = { ...this.rgb, alpha: Number(this.alphaInput.value) };
    this.leaveRainbow();
    this.emit();
  }

  private onEntry(): void {
    const parsed = parseAny(this.entry.value);
    if (parsed === null) {
      // Reported inline, and the text is LEFT ALONE. Clearing what somebody
      // typed to punish a typo is how a field becomes infuriating.
      this.entryError.hidden = false;
      this.entryError.textContent =
        'That is not a colour this can read. Try a name, a hex, or any notation below.';
      return;
    }
    this.entryError.hidden = true;
    this.rgb = parsed;
    this.leaveRainbow();
    this.remember();
    this.emit();
  }

  private onRainbow(): void {
    this.rainbow = this.rainbowToggle.checked;
    this.emit();
  }

  private onSpeed(): void {
    const level = Number(this.speedInput.value);
    this.speed = isSpeedLevel(level) ? level : DEFAULT_SPEED;
    this.emit();
  }

  /** Any direct edit leaves the rainbow: the two cannot both be in effect. */
  private leaveRainbow(): void {
    this.rainbow = false;
  }

  private remember(): void {
    const hex = toHex(this.rgb, this.rgb.alpha !== 1);
    this.recents = [hex, ...this.recents.filter((entry) => entry !== hex)].slice(0, 8);
  }

  // --------------------------------------------------------------- render --

  private render(): void {
    const hsv = rgbToHsv(this.rgb);

    this.hueInput.value = String(hsv.h);
    this.alphaInput.value = String(this.rgb.alpha);
    this.speedInput.value = String(this.speed);

    // The field shows the current hue at full saturation, with white across
    // and black down. Set as a custom property rather than an inline gradient
    // so the stylesheet owns the appearance.
    this.field.style.setProperty(
      '--picker-hue-colour',
      toHex(hsvToRgb({ h: hsv.h, s: 100, v: 100, alpha: 1 })),
    );
    this.fieldThumb.style.left = (hsv.s / 100) * FIELD_SIZE + 'px';
    this.fieldThumb.style.top = (1 - hsv.v / 100) * FIELD_SIZE + 'px';

    this.hueInput.style.setProperty('--picker-wheel', wheelStops().join(', '));

    this.preview.dataset['rainbow'] = this.rainbow ? 'yes' : 'no';
    this.preview.style.setProperty('--picker-current', toHex(this.rgb, true));
    this.preview.style.setProperty('--picker-rainbow-duration', durationFor(this.speed) + 's');
    this.preview.setAttribute(
      'aria-label',
      this.rainbow
        ? 'Cycling through the hues'
        : 'Current colour ' + format(this.rgb, 'hex') + ', ' + Math.round(this.rgb.alpha * 100) + '% opaque',
    );

    this.rainbowToggle.checked = this.rainbow;
    this.speedRow.hidden = !this.rainbow;
    const readout = this.speedRow.querySelector('.picker-speed-readout');
    if (readout !== null) {
      readout.textContent = 'level ' + this.speed + ' — one full cycle every ' + durationFor(this.speed) + 's';
    }

    if (document.activeElement !== this.entry) this.entry.value = format(this.rgb, 'hex');

    // ---- the translator ----
    clear(this.rows);
    for (const row of translate(this.rgb)) {
      const term = el('dt', { class: 'picker-notation' }, [
        el('span', { text: row.notation }),
        row.css ? null : el('span', { class: 'picker-not-css', text: 'not CSS' }),
      ]);
      const value = el('span', { class: 'picker-value', text: row.text });
      const copy = el('button', {
        class: 'picker-copy',
        type: 'button',
        'aria-label': 'Copy the ' + row.notation + ' form',
      }) as HTMLButtonElement;
      copy.textContent = 'Copy';
      copy.addEventListener('click', () => this.options.onCopy?.(row.text));

      this.rows.append(term, el('dd', { class: 'picker-translation' }, [value, copy]));
    }

    // ---- contrast ----
    const ratio = contrastRatio(this.rgb, this.against);
    const verdict = contrastVerdict(ratio);
    this.contrastRow.dataset['verdict'] = verdict;
    this.contrastRow.textContent =
      'Contrast against ' + toHex(this.against) + ': ' + ratio + ':1 — ' + verdict +
      (this.rgb.alpha !== 1
        ? '. Measured on the opaque colour, because a ratio through transparency depends on what is behind it.'
        : '');

    // ---- gamut ----
    const inGamut = isInSrgbGamut(this.rgb);
    this.gamutRow.hidden = inGamut;
    if (!inGamut) {
      this.gamutRow.textContent =
        'This colour is outside sRGB and has been clipped to fit. What is shown is not exactly what was asked for.';
    }

    // ---- recents ----
    clear(this.recentRow);
    if (this.recents.length === 0) {
      this.recentRow.append(
        el('p', { class: 'picker-recents-empty', text: 'Colours you enter will collect here.' }),
      );
    } else {
      for (const hex of this.recents) {
        const swatch = el('button', {
          class: 'picker-swatch',
          type: 'button',
          role: 'listitem',
          'aria-label': 'Use ' + hex,
        }) as HTMLButtonElement;
        // The sentinel is deliberately never in this list. A call site that
        // builds a tint by appending alpha would produce `rainbow33`, which is
        // an ignored declaration rather than an error, so the surface would
        // render with no background and nothing would say why.
        swatch.style.setProperty('--picker-swatch', hex);
        swatch.addEventListener('click', () => {
          const parsed = parseHex(hex);
          if (parsed !== null) {
            this.rgb = parsed;
            this.leaveRainbow();
            this.emit();
          }
        });
        this.recentRow.append(swatch);
      }
    }
  }
}

/** Exported for the tests: which notations the surface marks as non-CSS. */
export const NOT_CSS_NOTATIONS = NON_CSS;
