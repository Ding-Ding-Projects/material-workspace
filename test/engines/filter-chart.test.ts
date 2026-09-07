/**
 * Filtering and charting.
 *
 * The tests worth writing here are the ones about the things that are NOT
 * values: a blank, an error, a number stored as text. Every one of them has an
 * obvious wrong handling that produces a plausible answer, and a plausible
 * wrong answer in a spreadsheet is worse than an error, because it gets used.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bounds,
  niceNumber,
  renderChart,
  seriesColour,
} from '../../app/engines/sheet/chart';
import {
  type Condition,
  describeFilter,
  distinct,
  filterRows,
  matches,
} from '../../app/engines/sheet/filter';
import { BLANK, type ScalarValue, makeError } from '../../app/engines/sheet/values';

const DIV0 = makeError('DIV/0');

// ---------------------------------------------------------------- filter --

test('a filter HIDES rows; it never removes them', () => {
  // A spreadsheet that deletes what a filter excludes loses data every time
  // somebody narrows a view, and the loss is invisible until they clear it.
  const rows: ScalarValue[][] = [[1], [2], [3]];
  const before = JSON.stringify(rows);
  const result = filterRows(rows, [{ column: 0, comparison: 'greaterThan', value: 1 }]);
  assert.deepEqual(result.visible, [1, 2]);
  assert.equal(JSON.stringify(rows), before, 'the source rows were mutated');
});

test('a blank matches NOTHING except the blank tests', () => {
  // Treating it as 0 makes "less than 10" select every empty row in the sheet;
  // treating it as "" puts it in the same bucket as a cell somebody cleared.
  const condition = (comparison: Condition['comparison'], value?: string | number): Condition => ({
    column: 0,
    comparison,
    ...(value === undefined ? {} : { value }),
  });

  assert.equal(matches(BLANK, condition('lessThan', 10)), false);
  assert.equal(matches(BLANK, condition('equals', '')), false);
  assert.equal(matches(BLANK, condition('contains', '')), false);
  assert.equal(matches(BLANK, condition('isBlank')), true);
  assert.equal(matches(BLANK, condition('isNotBlank')), false);
});

test('an error matches nothing except the error test', () => {
  // Stringifying it makes "contains 0" select every #DIV/0! in the column.
  assert.equal(matches(DIV0, { column: 0, comparison: 'contains', value: '0' }), false);
  assert.equal(matches(DIV0, { column: 0, comparison: 'isError' }), true);
  assert.equal(matches(DIV0, { column: 0, comparison: 'isNotBlank' }), true);
});

test('a number stored as text is not the number', () => {
  // "10" sorts before "9" as text and after it as a number, so coercing
  // silently gives an answer that is right for one reading and wrong for the
  // other with nothing to say which happened.
  assert.equal(matches(10, { column: 0, comparison: 'equals', value: 10 }), true);
  assert.equal(matches('10', { column: 0, comparison: 'equals', value: 10 }), false);
  // But the text form still compares as text, which is what somebody typing a
  // string into a filter box means.
  assert.equal(matches('10', { column: 0, comparison: 'equals', value: '10' }), true);
});

test('a word and a number are not comparable, and that is not a match', () => {
  // Inventing an ordering puts rows in a filtered view nobody asked for.
  assert.equal(matches('apple', { column: 0, comparison: 'greaterThan', value: 5 }), false);
  assert.equal(matches(5, { column: 0, comparison: 'lessThan', value: 'apple' }), false);
});

test('text comparison ignores case and keeps accents', () => {
  // Somebody filtering for "smith" expects "Smith". Nobody filtering for
  // "resume" expects "résumé", and folding accents merges different people.
  assert.equal(matches('Smith', { column: 0, comparison: 'equals', value: 'smith' }), true);
  assert.equal(matches('résumé', { column: 0, comparison: 'equals', value: 'resume' }), false);
});

test('between is inclusive at both ends', () => {
  const condition: Condition = { column: 0, comparison: 'between', value: 1, upper: 10 };
  assert.equal(matches(1, condition), true);
  assert.equal(matches(10, condition), true);
  assert.equal(matches(0.9, condition), false);
  assert.equal(matches(10.1, condition), false);
});

test('the header row is always visible, whatever the filter says', () => {
  // Filtering it out makes a table unreadable; the alternative of filtering it
  // in puts "Total" in the list of distinct values.
  const rows: ScalarValue[][] = [['Name'], ['Ada'], ['Bea']];
  const result = filterRows(rows, [{ column: 0, comparison: 'equals', value: 'ada' }], {
    hasHeader: true,
  });
  assert.deepEqual(result.visible, [0, 1]);
  assert.equal(result.considered, 2);
  assert.equal(result.hidden, 1);
});

test('conditions combine with AND', () => {
  // A filter that silently ORs when somebody expected AND returns far too much.
  const rows: ScalarValue[][] = [
    [5, 'red'],
    [15, 'red'],
    [15, 'blue'],
  ];
  const result = filterRows(rows, [
    { column: 0, comparison: 'greaterThan', value: 10 },
    { column: 1, comparison: 'equals', value: 'red' },
  ]);
  assert.deepEqual(result.visible, [1]);
});

test('distinct keeps blanks and errors OUT of the list, and counts them', () => {
  // A list showing one blank-looking entry cannot say whether it means "no
  // value" or "the empty string", and those are different things.
  const rows: ScalarValue[][] = [['a'], [BLANK], ['b'], [DIV0], ['a']];
  const result = distinct(rows, 0);
  assert.deepEqual(result.values, ['a', 'b']);
  assert.equal(result.blanks, 1);
  assert.equal(result.errors, 1);
});

test('distinct keeps the number 10 and the string "10" apart', () => {
  // Merging them is how a filter silently selects both.
  const rows: ScalarValue[][] = [[10], ['10']];
  assert.equal(distinct(rows, 0).values.length, 2);
});

test('the sentence says rows are HIDDEN, not gone', () => {
  const result = filterRows(
    [[1], [2], [3]],
    [{ column: 0, comparison: 'greaterThan', value: 2 }],
  );
  const sentence = describeFilter(result);
  assert.match(sentence, /1 of 3/);
  assert.match(sentence, /hidden, not removed/);
});

// ----------------------------------------------------------------- chart --

test('a BAR chart always includes zero, whatever the data is', () => {
  // THE ONE THAT LIES MOST CONVINCINGLY. Bar length is the comparison, so an
  // axis starting at 90 makes 91 look twice 90.
  const axis = bounds('bar', [90, 91, 92]);
  assert.equal(axis.min, 0);
  assert.equal(axis.startsAtZero, true);
});

test('a LINE chart may crop, because position rather than length carries it', () => {
  const axis = bounds('line', [90, 91, 92]);
  assert.ok(axis.min > 0, 'a line chart was forced to zero');
  assert.equal(axis.startsAtZero, false);
});

test('a cropped axis SAYS SO on the chart', () => {
  // A reader who cannot see that the axis is cropped reads the exaggeration as
  // the data.
  const chart = renderChart({
    kind: 'line',
    title: 'Close up',
    categories: ['a', 'b'],
    series: [{ name: 's', values: [90, 92], colour: seriesColour(0) }],
    width: 400,
    height: 300,
  });
  assert.ok(chart.axisNote !== null, 'a cropped axis said nothing');
  assert.match(chart.axisNote ?? '', /not at zero/);
});

test('an axis that starts at zero says nothing, because there is nothing to say', () => {
  const chart = renderChart({
    kind: 'bar',
    title: 'From zero',
    categories: ['a'],
    series: [{ name: 's', values: [5], colour: seriesColour(0) }],
    width: 400,
    height: 300,
  });
  assert.equal(chart.axisNote, null);
});

test('ticks land on readable numbers', () => {
  // An axis from 0 to 97 with five ticks otherwise gives 19.4, 38.8, 58.2 -
  // technically correct and unreadable.
  assert.equal(niceNumber(97, false), 100);
  assert.equal(niceNumber(0.021, false), 0.025);
  assert.equal(niceNumber(-97, false), -100);
  assert.equal(niceNumber(0, false), 0);
});

test('a blank is a GAP, not a zero', () => {
  // Plotting it as zero draws a line to the floor and back, and the reader
  // sees a crash that never happened.
  const chart = renderChart({
    kind: 'bar',
    title: 'With a hole',
    categories: ['a', 'b', 'c'],
    series: [{ name: 's', values: [10, BLANK, 12], colour: seriesColour(0) }],
    width: 400,
    height: 300,
  });
  assert.equal(chart.bars.length, 2, 'a gap was drawn as a bar');
  assert.equal(chart.gaps, 1);
});

test('an error is a gap too', () => {
  const chart = renderChart({
    kind: 'bar',
    title: 'With an error',
    categories: ['a', 'b'],
    series: [{ name: 's', values: [10, DIV0], colour: seriesColour(0) }],
    width: 400,
    height: 300,
  });
  assert.equal(chart.bars.length, 1);
  assert.equal(chart.gaps, 1);
});

test('a line does not join ACROSS a gap', () => {
  // A line drawn through a gap asserts a value nobody recorded.
  const chart = renderChart({
    kind: 'line',
    title: 'Broken',
    categories: ['a', 'b', 'c', 'd'],
    series: [{ name: 's', values: [1, BLANK, 3, 4], colour: seriesColour(0) }],
    width: 400,
    height: 300,
  });
  const runs = chart.lines[0]?.runs ?? [];
  assert.equal(runs.length, 2, 'the line joined across the gap');
  assert.equal(runs[0]?.length, 1);
  assert.equal(runs[1]?.length, 2);
});

test('flat data still draws, rather than collapsing to NaN', () => {
  // Every value equal gives a zero-height range; dividing by it puts every
  // point at NaN, which draws nothing and looks like a chart that failed to
  // load rather than one with flat data.
  const chart = renderChart({
    kind: 'line',
    title: 'Flat',
    categories: ['a', 'b', 'c'],
    series: [{ name: 's', values: [7, 7, 7], colour: seriesColour(0) }],
    width: 400,
    height: 300,
  });
  const points = chart.lines[0]?.runs[0] ?? [];
  assert.equal(points.length, 3);
  for (const point of points) {
    assert.ok(Number.isFinite(point.y), 'a point came out as ' + point.y);
  }
});

test('every value zero still draws', () => {
  const chart = renderChart({
    kind: 'bar',
    title: 'Zeros',
    categories: ['a', 'b'],
    series: [{ name: 's', values: [0, 0], colour: seriesColour(0) }],
    width: 400,
    height: 300,
  });
  assert.equal(chart.bars.length, 2);
  for (const bar of chart.bars) assert.ok(Number.isFinite(bar.y));
});

test('a negative bar draws DOWNWARD from the baseline', () => {
  // Pinning every bar to the bottom of the plot loses the sign entirely, and a
  // chart of temperatures reads as though every month were above freezing.
  const chart = renderChart({
    kind: 'bar',
    title: 'Temperatures',
    categories: ['a', 'b'],
    series: [{ name: 's', values: [10, -10], colour: seriesColour(0) }],
    width: 400,
    height: 300,
  });

  const positive = chart.bars[0] as { y: number; height: number };
  const negative = chart.bars[1] as { y: number; height: number };
  assert.ok(positive.y < chart.baselineY, 'the positive bar is not above the baseline');
  assert.ok(negative.y >= chart.baselineY - 0.001, 'the negative bar is not below the baseline');
  assert.ok(Math.abs(positive.height - negative.height) < 0.5, 'the two bars differ in length');
});

test('a chart with no data at all still has a plot area and ticks', () => {
  // Returning nothing gives a surface with no axes, which reads as a broken
  // chart rather than as an empty one.
  const chart = renderChart({
    kind: 'bar',
    title: 'Nothing yet',
    categories: [],
    series: [],
    width: 400,
    height: 300,
  });
  assert.ok(chart.plot.width > 0);
  assert.ok(chart.ticks.length > 0);
  assert.equal(chart.bars.length, 0);
});

test('series colours repeat rather than running out', () => {
  assert.equal(seriesColour(0), seriesColour(6));
  assert.notEqual(seriesColour(0), seriesColour(1));
});
