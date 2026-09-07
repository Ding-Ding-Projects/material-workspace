/**
 * Charts, as geometry rather than as pixels.
 *
 * This computes where everything goes - axes, ticks, bars, points, the plot
 * area - and hands back a description. Drawing is the surface's job, which is
 * what lets the same chart be an SVG on screen, a path in an export, and a set
 * of numbers in a test.
 *
 * SIX THINGS THAT MAKE A CHART LIE, AND EVERY ONE OF THEM LOOKS FINE.
 *
 *   - A BAR CHART WHOSE AXIS DOES NOT START AT ZERO. Bar length IS the
 *     comparison; starting the axis at 90 makes 91 look twice 90. A line chart
 *     may crop its axis because position, not length, carries the meaning - so
 *     the rule is per chart type, not a global preference.
 *
 *   - NICE NUMBERS ARE NOT ROUND NUMBERS. An axis from 0 to 97 with five ticks
 *     gives 19.4, 38.8, 58.2 - technically correct and unreadable. Ticks have
 *     to land on 1, 2, 2.5 or 5 times a power of ten.
 *
 *   - A BLANK IS NOT A ZERO. A gap in a series is missing data; plotting it as
 *     zero draws a line to the floor and back, and the reader sees a crash
 *     that never happened.
 *
 *   - AN ERROR IS NOT A VALUE EITHER. Charting #DIV/0! as zero is the same lie
 *     with an extra step.
 *
 *   - EVERY VALUE EQUAL MEANS A ZERO-HEIGHT RANGE. Dividing by it gives
 *     infinity, and every point lands at NaN - which draws nothing at all and
 *     looks like a chart that failed to load rather than one with flat data.
 *
 *   - NEGATIVE VALUES NEED THE BASELINE INSIDE THE PLOT. A bar chart of
 *     temperatures with the baseline pinned to the bottom draws every bar the
 *     same way up and loses the sign entirely.
 */

import { BLANK, type ScalarValue, isError } from './values.js';

export type ChartKind = 'bar' | 'line' | 'scatter';

export interface Series {
  readonly name: string;
  /** A blank or an error is a GAP, never a zero. */
  readonly values: readonly ScalarValue[];
  readonly colour: string;
}

export interface ChartSpec {
  readonly kind: ChartKind;
  readonly title: string;
  /** Category labels along the horizontal axis. */
  readonly categories: readonly string[];
  readonly series: readonly Series[];
  readonly width: number;
  readonly height: number;
}

export interface Tick {
  readonly value: number;
  readonly label: string;
  /** Points from the top of the chart. */
  readonly y: number;
}

export interface Bar {
  readonly series: string;
  readonly category: string;
  readonly value: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly colour: string;
}

export interface Point {
  readonly series: string;
  readonly category: string;
  readonly value: number;
  readonly x: number;
  readonly y: number;
  readonly colour: string;
}

export interface Line {
  readonly series: string;
  readonly colour: string;
  /**
   * Point runs. A gap in the data starts a NEW run rather than joining across
   * it - a line drawn through a gap asserts a value nobody recorded.
   */
  readonly runs: readonly (readonly Point[])[];
}

export interface PlotArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RenderedChart {
  readonly kind: ChartKind;
  readonly title: string;
  readonly plot: PlotArea;
  readonly ticks: readonly Tick[];
  readonly bars: readonly Bar[];
  readonly lines: readonly Line[];
  readonly categories: readonly { readonly label: string; readonly x: number }[];
  /** Y of the value zero, for a baseline that is not always the bottom. */
  readonly baselineY: number;
  /** Said on the chart when the axis does not start at zero. */
  readonly axisNote: string | null;
  /** Values that could not be plotted, so the surface can say how many. */
  readonly gaps: number;
}

const MARGIN = { top: 32, right: 16, bottom: 40, left: 56 };

/**
 * Round an axis bound outward to a readable number.
 *
 * 1, 2, 2.5 and 5 times a power of ten. An axis from 0 to 97 with five ticks
 * otherwise gives 19.4, 38.8, 58.2 - correct and unreadable.
 */
export function niceNumber(value: number, roundDown: boolean): number {
  if (value === 0) return 0;
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  const exponent = Math.floor(Math.log10(magnitude));
  const power = Math.pow(10, exponent);
  const fraction = magnitude / power;

  const steps = [1, 2, 2.5, 5, 10];
  let chosen = 10;
  if (roundDown) {
    chosen = 1;
    for (const step of steps) if (step <= fraction) chosen = step;
  } else {
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      if ((steps[index] as number) >= fraction) chosen = steps[index] as number;
    }
  }
  return sign * chosen * power;
}

/** A number, or null when the cell is a gap rather than a value. */
function numeric(value: ScalarValue): number | null {
  // A blank is missing data and an error is not a value. Charting either as
  // zero draws a line to the floor and back, and a reader sees a crash that
  // never happened.
  if (value === BLANK || isError(value)) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && String(value).trim() !== '' ? parsed : null;
}

export interface AxisBounds {
  readonly min: number;
  readonly max: number;
  readonly startsAtZero: boolean;
}

/**
 * The vertical bounds.
 *
 * A BAR CHART ALWAYS INCLUDES ZERO, because bar length is the comparison and
 * an axis starting at 90 makes 91 look twice 90. A line or scatter may crop,
 * because position rather than length carries the meaning - and when it does,
 * the chart says so.
 */
export function bounds(kind: ChartKind, values: readonly number[]): AxisBounds {
  if (values.length === 0) return { min: 0, max: 1, startsAtZero: true };

  let low = Math.min(...values);
  let high = Math.max(...values);

  if (kind === 'bar') {
    if (low > 0) low = 0;
    if (high < 0) high = 0;
  }

  // Every value the same gives a zero-height range; dividing by it produces
  // NaN for every point, which draws nothing and looks like a chart that
  // failed to load rather than one with flat data.
  if (low === high) {
    if (low === 0) {
      high = 1;
    } else {
      const pad = Math.abs(low) * 0.1;
      low -= pad;
      high += pad;
    }
  }

  const niceLow = low === 0 ? 0 : niceNumber(low, low > 0);
  const niceHigh = high === 0 ? 0 : niceNumber(high, high < 0);

  return {
    min: Math.min(niceLow, low),
    max: Math.max(niceHigh, high),
    startsAtZero: Math.min(niceLow, low) === 0,
  };
}

const PALETTE = ['#4f6bed', '#c62828', '#2e7d32', '#f9a825', '#6a1b9a', '#00838f'];

/** A colour for a series, by position, when none was chosen. */
export function seriesColour(index: number): string {
  return PALETTE[index % PALETTE.length] as string;
}

export function renderChart(spec: ChartSpec): RenderedChart {
  const plot: PlotArea = {
    x: MARGIN.left,
    y: MARGIN.top,
    width: Math.max(1, spec.width - MARGIN.left - MARGIN.right),
    height: Math.max(1, spec.height - MARGIN.top - MARGIN.bottom),
  };

  const numbers: number[] = [];
  let gaps = 0;
  for (const series of spec.series) {
    for (const value of series.values) {
      const number = numeric(value);
      if (number === null) gaps += 1;
      else numbers.push(number);
    }
  }

  const axis = bounds(spec.kind, numbers);
  const span = axis.max - axis.min || 1;
  const yFor = (value: number): number =>
    plot.y + plot.height - ((value - axis.min) / span) * plot.height;

  const ticks: Tick[] = [];
  const TICKS = 5;
  for (let index = 0; index <= TICKS; index += 1) {
    const value = axis.min + (span * index) / TICKS;
    ticks.push({
      value,
      // Trailing zeros trimmed, so an axis of whole numbers does not read
      // "1.00, 2.00" and imply a precision the data does not have.
      label: formatTick(value, span),
      y: yFor(value),
    });
  }

  const slot = plot.width / Math.max(1, spec.categories.length);
  const categories = spec.categories.map((label, index) => ({
    label,
    x: plot.x + slot * (index + 0.5),
  }));

  const baselineY = yFor(Math.max(axis.min, Math.min(0, axis.max)));

  const bars: Bar[] = [];
  const lines: Line[] = [];

  if (spec.kind === 'bar') {
    const groupWidth = slot * 0.7;
    const barWidth = groupWidth / Math.max(1, spec.series.length);

    spec.series.forEach((series, seriesIndex) => {
      series.values.forEach((raw, categoryIndex) => {
        const value = numeric(raw);
        // A gap is SKIPPED, not drawn at zero. A zero-height bar at the
        // baseline reads as a real measurement of nothing.
        if (value === null) return;

        const y = yFor(value);
        const x =
          plot.x + slot * categoryIndex + (slot - groupWidth) / 2 + barWidth * seriesIndex;

        bars.push({
          series: series.name,
          category: spec.categories[categoryIndex] ?? '',
          value,
          x,
          y: Math.min(y, baselineY),
          width: barWidth,
          // Measured from the BASELINE, so a negative value draws downward
          // rather than being pinned to the bottom of the plot.
          height: Math.abs(baselineY - y),
          colour: series.colour,
        });
      });
    });
  } else {
    spec.series.forEach((series) => {
      const runs: Point[][] = [];
      let run: Point[] = [];

      series.values.forEach((raw, categoryIndex) => {
        const value = numeric(raw);
        if (value === null) {
          // A gap ENDS the run. Joining across it draws a line through data
          // nobody recorded, which is an assertion the file never made.
          if (run.length > 0) runs.push(run);
          run = [];
          return;
        }
        run.push({
          series: series.name,
          category: spec.categories[categoryIndex] ?? '',
          value,
          x: plot.x + slot * (categoryIndex + 0.5),
          y: yFor(value),
          colour: series.colour,
        });
      });

      if (run.length > 0) runs.push(run);
      lines.push({ series: series.name, colour: series.colour, runs });
    });
  }

  return {
    kind: spec.kind,
    title: spec.title,
    plot,
    ticks,
    bars,
    lines,
    categories,
    baselineY,
    // Said ON the chart, not only in the code. A cropped axis exaggerates
    // every difference, and a reader who cannot see that it is cropped reads
    // the exaggeration as the data.
    axisNote: axis.startsAtZero
      ? null
      : 'The vertical axis starts at ' + formatTick(axis.min, span) + ', not at zero.',
    gaps,
  };
}

function formatTick(value: number, span: number): string {
  // Precision from the SPAN rather than from the value: an axis from 0 to 1
  // needs two decimals and an axis from 0 to 10000 needs none, and using the
  // value alone gives a different precision on every tick.
  const decimals = span >= 100 ? 0 : span >= 10 ? 1 : 2;
  const fixed = value.toFixed(decimals);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}
