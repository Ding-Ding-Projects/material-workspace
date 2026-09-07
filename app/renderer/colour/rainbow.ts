/**
 * The animated rainbow: a colour that cycles the hue continuously.
 *
 * It is one of the choices in the picker rather than a setting somewhere else,
 * because a rainbow that lives in a preferences page far from the control is a
 * rainbow nobody finds.
 *
 * IT IS A SENTINEL, NOT A COLOUR STRING, and that is the load-bearing decision
 * in this file. No colour string can change over time, so the stored value is
 * a marker the renderer recognises. Everything below follows from that:
 *
 *   - Keeping it OUT of the swatch palette matters more than it looks. Call
 *     sites routinely build a tint by appending alpha to a stored value, and a
 *     sentinel there produces `rainbow33` - which is not an error, merely an
 *     ignored declaration, so the surface renders with no background and
 *     nothing anywhere says why.
 *   - The animation belongs in the stylesheet. A timer that re-renders a
 *     component many times a second to repaint one colour is the expensive way
 *     to do a thing CSS does for free, and it is the version that stutters
 *     under load.
 *   - The speed is stored as a LEVEL, not a duration. Seconds are a unit
 *     nobody has an intuition for, a slider where a bigger number means slower
 *     is a control people fight, and a hand-edited settings file can otherwise
 *     put NaN into a CSS duration - which silently disables the animation
 *     rather than failing.
 */

import { hslToRgb, normaliseHue, toHex, type Rgb } from './convert';

/**
 * The stored marker.
 *
 * Deliberately not a valid CSS colour, so a call site that passes it straight
 * through fails visibly in development rather than rendering something
 * plausible and wrong.
 */
export const RAINBOW = 'rainbow' as const;

export type ColourValue = string;

export function isRainbow(value: ColourValue): boolean {
  return value === RAINBOW;
}

/**
 * Speed levels and the durations they mean.
 *
 * Published here so the control and the stylesheet read the same table, and so
 * the mapping is checkable rather than asserted. A bigger level is faster,
 * which is the direction people expect from something labelled Speed.
 */
export const SPEED_LEVELS = [1, 2, 3, 4, 5] as const;
export type SpeedLevel = (typeof SPEED_LEVELS)[number];

const DURATIONS: Record<SpeedLevel, number> = {
  1: 24,
  2: 12,
  3: 6,
  4: 3,
  5: 1.5,
};

export const DEFAULT_SPEED: SpeedLevel = 3;

/**
 * The animation duration in seconds for a level.
 *
 * A value that is not one of the levels falls back to the default rather than
 * being coerced. A hand-edited settings file holding `"speed": "fast"` would
 * otherwise reach the stylesheet as `NaNs`, and an invalid duration silently
 * disables the animation instead of failing - so the rainbow stops moving and
 * nothing anywhere explains why.
 */
export function durationFor(level: unknown): number {
  const known = SPEED_LEVELS.find((candidate) => candidate === level);
  return DURATIONS[known ?? DEFAULT_SPEED];
}

export function isSpeedLevel(value: unknown): value is SpeedLevel {
  return SPEED_LEVELS.some((level) => level === value);
}

/**
 * The hue at a moment, for a preview and for the reduced-motion still.
 *
 * Walks the wheel rather than interpolating between two endpoints. Two stops
 * from red to red fade through GREY, because the shortest path between two
 * identical hues is no path at all - which is why the naive gradient
 * implementation of this looks broken.
 */
export function hueAt(elapsedSeconds: number, level: SpeedLevel = DEFAULT_SPEED): number {
  const duration = durationFor(level);
  return normaliseHue((elapsedSeconds / duration) * 360);
}

export function rainbowColourAt(
  elapsedSeconds: number,
  level: SpeedLevel = DEFAULT_SPEED,
  saturation = 85,
  lightness = 55,
): Rgb {
  return hslToRgb({ h: hueAt(elapsedSeconds, level), s: saturation, l: lightness, alpha: 1 });
}

/**
 * The one hue a reduced-motion reader settles on.
 *
 * REDUCED MOTION SETTLES; IT DOES NOT MERELY SLOW DOWN. A slow cycle is still
 * motion, and a continuously changing background is exactly what that
 * preference exists to stop. The colour must still read as a deliberate choice
 * rather than as a failure to load, so it is a saturated hue rather than grey.
 */
export const STILL_HUE = 210;

export function stillColour(saturation = 85, lightness = 55): Rgb {
  return hslToRgb({ h: STILL_HUE, s: saturation, l: lightness, alpha: 1 });
}

/**
 * The stops for a hue-wheel gradient preview.
 *
 * Seven stops rather than two, and the last repeats the first, so the wheel is
 * walked rather than crossed.
 */
export function wheelStops(saturation = 85, lightness = 55): string[] {
  const stops: string[] = [];
  for (let hue = 0; hue <= 360; hue += 60) {
    stops.push(toHex(hslToRgb({ h: hue % 360, s: saturation, l: lightness, alpha: 1 })));
  }
  return stops;
}

/**
 * Resolve a stored value to something that can actually be painted.
 *
 * The sentinel becomes the still colour, because a static context - a
 * screenshot, an export, a contrast calculation - has no time axis to animate
 * along. Returning the sentinel would put an invalid string into a stylesheet.
 */
export function resolveForStatic(value: ColourValue): string {
  return isRainbow(value) ? toHex(stillColour()) : value;
}

/**
 * The properties a surface publishes ONCE, globally, for every rainbow on it.
 *
 * Published once and not per element, because a duration set per element makes
 * them drift apart by however long apart they were mounted. A screen where six
 * rainbows each show a different hue reads as a rendering fault rather than as
 * a deliberate choice.
 */
export function globalRainbowProperties(
  level: SpeedLevel,
  reducedMotion: boolean,
): Record<string, string> {
  return {
    '--workspace-rainbow-duration': durationFor(level) + 's',
    '--workspace-rainbow-play': reducedMotion ? 'paused' : 'running',
    '--workspace-rainbow-still': toHex(stillColour()),
  };
}
