/**
 * Per-element appearance.
 *
 * Most of these are refusals, because the stored value ends up in a style
 * attribute. A settings file can be edited by hand and a theme can arrive
 * through an import, so anything this accepts is something an attacker with a
 * file on disk can put into the page.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  NO_STYLES,
  PROPERTIES,
  type StyleBook,
  accept,
  copyStyle,
  countOverrides,
  declarationsFor,
  exportTheme,
  importTheme,
  propertyFor,
  resetAll,
  resetElement,
  resetProperty,
  setProperty,
  styleIdFor,
} from '../../app/shared/element-style';

function put(book: StyleBook, element: string, property: string, value: string): StyleBook {
  const result = setProperty(book, element, property, value);
  assert.ok(!('ok' in result), 'expected ' + property + '=' + value + ' to be accepted');
  return (result as { book: StyleBook }).book;
}

// ------------------------------------------------------------ definitions --

test('every property is complete enough to render a control from', () => {
  // A definition missing its kind or its CSS property renders an empty row
  // that looks like a control and does nothing at all.
  for (const property of PROPERTIES) {
    assert.ok(property.id.length > 0, 'a property has no id');
    assert.ok(property.label.length > 0, property.id + ' has no label');
    assert.ok(property.css.length > 0, property.id + ' writes no CSS property');
    if (property.kind === 'choice') {
      assert.ok(property.options !== undefined, property.id + ' is a choice with no options');
    }
    if (property.kind === 'toggle') {
      assert.ok(property.on !== undefined && property.off !== undefined, property.id);
    }
    if (property.kind === 'length' || property.kind === 'number') {
      assert.ok(property.min !== undefined && property.max !== undefined, property.id);
      assert.ok((property.min as number) < (property.max as number), property.id);
    }
  }
});

test('no two properties share an id, and none writes the same CSS twice', () => {
  // Two rows writing one CSS property is a pair where the later one silently
  // wins, and the user watches the other control do nothing.
  const ids = new Set(PROPERTIES.map((property) => property.id));
  assert.equal(ids.size, PROPERTIES.length, 'a property id is used twice');
  const css = new Set(PROPERTIES.map((property) => property.css));
  assert.equal(css.size, PROPERTIES.length, 'two properties write the same CSS property');
});

test('the typography set really is Word-depth rather than a token gesture', () => {
  // A hand-written list, so a property that disappeared in a refactor fails
  // here rather than quietly leaving the editor.
  for (const id of [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'fontVariantCaps',
    'textTransform',
    'textDecorationLine',
    'textDecorationStyle',
    'textDecorationColor',
    'verticalAlign',
    'textAlign',
    'direction',
    'letterSpacing',
    'wordSpacing',
    'lineHeight',
  ]) {
    assert.ok(propertyFor(id) !== undefined, id + ' is missing from the editor');
  }
});

test('a property with a platform limit says what the limit is', () => {
  const stroke = propertyFor('textStroke');
  assert.ok(stroke !== undefined);
  // Still present, not hidden. A control that disappears reads as a build that
  // forgot it rather than as a limitation somebody decided.
  assert.ok((stroke?.unsupported ?? '').length > 20, 'the limitation is not explained');
});

// -------------------------------------------------------------- accepting --

test('a number outside its range is refused, and the range is named', () => {
  const tooBig = accept('fontSize', '400');
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.ok === false ? tooBig.reason : '', /6 to 96/);
  assert.equal(accept('fontSize', '12').ok, true);
});

test('a number is normalised, so one value cannot be stored two ways', () => {
  const result = accept('fontSize', '12.0');
  assert.equal(result.ok, true);
  assert.equal(result.ok === true ? result.value : '', '12');
});

test('a choice outside its list is refused', () => {
  assert.equal(accept('textAlign', 'sideways').ok, false);
  assert.equal(accept('textAlign', 'justify').ok, true);
});

test('a toggle takes its two states and nothing else', () => {
  assert.equal(accept('fontVariantCaps', 'small-caps').ok, true);
  assert.equal(accept('fontVariantCaps', 'normal').ok, true);
  assert.equal(accept('fontVariantCaps', 'true').ok, false);
});

test('an unknown property is refused rather than stored for later', () => {
  const result = accept('nonsense', 'anything');
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : '', /no property called nonsense/);
});

test('an empty value is refused rather than stored as a no-op override', () => {
  assert.equal(accept('color', '   ').ok, false);
});

// ---------------------------------------------------- the injection cases --

test('a colour cannot smuggle anything into the style attribute', () => {
  // THE ONE THAT MATTERS. This value is written into a style attribute, and a
  // settings file can be edited by hand or arrive through an import.
  for (const attempt of [
    'url(http://example.invalid/x.png)',
    'red; background-image: url(evil)',
    'rgb(0,0,0) !important',
    'var(--anything)',
    'expression(alert(1))',
    'image-set("a.png")',
    '#fff}',
    'attr(href)',
  ]) {
    assert.equal(accept('color', attempt).ok, false, 'accepted ' + attempt);
  }
});

test('and the notations a colour genuinely comes in are all accepted', () => {
  for (const good of [
    '#fff',
    '#ffffff',
    '#ffffff80',
    'rgb(12, 34, 56)',
    'rgba(12,34,56,0.5)',
    'hsl(210 40% 50%)',
    'oklch(0.7 0.1 250)',
    'rebeccapurple',
  ]) {
    assert.equal(accept('color', good).ok, true, 'refused ' + good);
  }
});

test('a run-time choice cannot end the declaration it sits in', () => {
  // The font list is filled from the machine, so this property has no fixed
  // options and would otherwise be free text in a style attribute.
  for (const attempt of [
    'Arial; color: red',
    'Arial}',
    'url(x)',
    'Arial /* */',
    'x'.repeat(200),
  ]) {
    assert.equal(accept('fontFamily', attempt).ok, false, 'accepted ' + attempt);
  }
  assert.equal(accept('fontFamily', 'Segoe UI').ok, true);
  assert.equal(accept('fontFamily', 'Noto Sans HK').ok, true);
});

// ---------------------------------------------------------------- writing --

test('setting one property leaves the others alone', () => {
  let book = put(NO_STYLES, 'tab-writer', 'color', '#ff0000');
  book = put(book, 'tab-writer', 'fontSize', '18');
  assert.equal(countOverrides(book, 'tab-writer'), 2);
  assert.equal(book['tab-writer']?.['color'], '#ff0000');
});

test('setting one element leaves other elements alone', () => {
  let book = put(NO_STYLES, 'a', 'color', '#ff0000');
  book = put(book, 'b', 'color', '#00ff00');
  assert.equal(book['a']?.['color'], '#ff0000');
  assert.equal(book['b']?.['color'], '#00ff00');
});

test('a refused value changes nothing at all', () => {
  const book = put(NO_STYLES, 'a', 'color', '#ff0000');
  const result = setProperty(book, 'a', 'color', 'url(evil)');
  assert.ok('ok' in result && result.ok === false);
  assert.equal(book['a']?.['color'], '#ff0000', 'the old value was disturbed');
});

test('writing does not mutate the book handed in', () => {
  // The editor holds a previous book to undo back to. Mutating in place would
  // make that undo restore the value it was undoing.
  const before = put(NO_STYLES, 'a', 'color', '#ff0000');
  const snapshot = JSON.stringify(before);
  put(before, 'a', 'fontSize', '20');
  assert.equal(JSON.stringify(before), snapshot, 'the earlier book was mutated');
});

// ---------------------------------------------------------------- resets --

test('resetting one property keeps the rest of the element', () => {
  let book = put(NO_STYLES, 'a', 'color', '#ff0000');
  book = put(book, 'a', 'fontSize', '18');
  book = resetProperty(book, 'a', 'color');
  assert.equal(countOverrides(book, 'a'), 1);
  assert.equal(book['a']?.['fontSize'], '18');
});

test('resetting the last property removes the element entirely', () => {
  // An empty record left behind makes an exported theme accumulate entries
  // that say nothing, and makes "is this customized" answer yes for ever.
  let book = put(NO_STYLES, 'a', 'color', '#ff0000');
  book = resetProperty(book, 'a', 'color');
  assert.equal('a' in book, false);
  assert.equal(countOverrides(book, 'a'), 0);
});

test('resetting an element does not touch its neighbours', () => {
  let book = put(NO_STYLES, 'a', 'color', '#ff0000');
  book = put(book, 'b', 'color', '#00ff00');
  book = resetElement(book, 'a');
  assert.equal('a' in book, false);
  assert.equal(book['b']?.['color'], '#00ff00');
});

test('resetting something that was never set is not an error', () => {
  assert.deepEqual(resetProperty(NO_STYLES, 'ghost', 'color'), NO_STYLES);
  assert.deepEqual(resetElement(NO_STYLES, 'ghost'), NO_STYLES);
});

test('reset-all really empties it', () => {
  assert.equal(Object.keys(resetAll()).length, 0);
});

// ---------------------------------------------------------------- copying --

test('copying a style takes every property and replaces what was there', () => {
  let book = put(NO_STYLES, 'a', 'color', '#ff0000');
  book = put(book, 'a', 'fontSize', '18');
  book = put(book, 'b', 'lineHeight', '2');
  book = copyStyle(book, 'a', 'b');
  assert.deepEqual(book['b'], { color: '#ff0000', fontSize: '18' });
});

test('copying from an element with no style CLEARS the target', () => {
  // Otherwise "copy style" from an untouched element leaves the target as it
  // was, which reads as the copy having failed.
  let book = put(NO_STYLES, 'b', 'color', '#00ff00');
  book = copyStyle(book, 'never-styled', 'b');
  assert.equal('b' in book, false);
});

// -------------------------------------------------------------- declaring --

test('declarations carry the unit, so a bare number is never written as CSS', () => {
  // font-size: 18 is not a length and is silently ignored by every engine, so
  // the control would appear to do nothing.
  const book = put(NO_STYLES, 'a', 'fontSize', '18');
  assert.deepEqual(declarationsFor(book, 'a'), [['font-size', '18px']]);
});

test('a unitless property stays unitless', () => {
  const book = put(NO_STYLES, 'a', 'lineHeight', '1.5');
  assert.deepEqual(declarationsFor(book, 'a'), [['line-height', '1.5']]);
});

test('an element with no overrides declares nothing', () => {
  assert.deepEqual(declarationsFor(NO_STYLES, 'a'), []);
});

test('a stored property this version no longer knows is skipped, not written', () => {
  // An older theme can carry a property that has since been removed. Writing
  // it blind would put an unknown name into the style attribute.
  const book: StyleBook = { a: { color: '#ff0000', retired: 'whatever' } };
  assert.deepEqual(declarationsFor(book, 'a'), [['color', '#ff0000']]);
});

// ------------------------------------------------------ export and import --

test('a theme round-trips', () => {
  let book = put(NO_STYLES, 'a', 'color', '#ff0000');
  book = put(book, 'b', 'fontSize', '20');

  const file = JSON.parse(JSON.stringify(exportTheme(book)));
  const result = importTheme(file);
  assert.ok(!('ok' in result));
  const imported = result as { book: StyleBook; skipped: readonly string[] };
  assert.deepEqual(imported.book, book);
  assert.deepEqual(imported.skipped, []);
});

test('an import re-checks every value, so a hand-edited file cannot inject', () => {
  // THE REASON THE IMPORT IS NOT JUST JSON.parse. A theme file is an ordinary
  // file on disk that anybody can open in an editor.
  const result = importTheme({
    kind: 'material-workspace-element-theme',
    version: 1,
    styles: {
      a: { color: 'red; background-image: url(evil)', fontSize: '18' },
    },
  });
  assert.ok(!('ok' in result));
  const imported = result as { book: StyleBook; skipped: readonly string[] };
  assert.deepEqual(imported.book, { a: { fontSize: '18' } });
  assert.equal(imported.skipped.length, 1);
  assert.match(imported.skipped[0] as string, /a\.color/);
});

test('what an import would not apply is REPORTED, never silently dropped', () => {
  const result = importTheme({
    kind: 'material-workspace-element-theme',
    version: 1,
    styles: { a: { retired: 'x', fontSize: '900' }, b: 'not an object' },
  });
  assert.ok(!('ok' in result));
  const imported = result as { book: StyleBook; skipped: readonly string[] };
  assert.equal(imported.skipped.length, 3, imported.skipped.join(' | '));
  assert.equal(Object.keys(imported.book).length, 0);
});

test('a file that is not a theme is refused with a reason', () => {
  for (const bad of [null, 42, 'text', [], {}, { kind: 'something-else' }]) {
    const result = importTheme(bad);
    assert.ok('ok' in result && result.ok === false, JSON.stringify(bad));
  }
});

test('a theme from a different version is refused rather than half-read', () => {
  const result = importTheme({
    kind: 'material-workspace-element-theme',
    version: 2,
    styles: {},
  });
  assert.ok('ok' in result && result.ok === false);
  assert.match((result as { reason: string }).reason, /different version/);
});

// ------------------------------------------------------------- identity --

test('an explicit style id wins outright and stops the walk', () => {
  const id = styleIdFor([
    { tag: 'button', styleId: 'writer-bold' },
    { tag: 'div', classes: ['toolbar'] },
  ]);
  assert.equal(id, 'writer-bold');
});

test('an id further up is still found, because the leaf rarely declares one', () => {
  assert.equal(
    styleIdFor([{ tag: 'span', classes: ['label'] }, { tag: 'button', styleId: 'tab-writer' }]),
    'tab-writer',
  );
});

test('without an explicit id it uses classes, and stays SHORT', () => {
  // A path from the root encodes every wrapper in between, so inserting one
  // container renames every stored style beneath it and the user's work
  // silently stops applying. Three steps is the trade.
  const id = styleIdFor([
    { tag: 'span', classes: ['tab__label'] },
    { tag: 'button', classes: ['tab'] },
    { tag: 'div', classes: ['tab-strip'] },
    { tag: 'div', classes: ['shell'] },
    { tag: 'body', classes: [] },
  ]);
  assert.equal(id, 'tab__label>tab>tab-strip');
});

test('an element with no classes falls back to its tag and position', () => {
  assert.equal(styleIdFor([{ tag: 'p', index: 2 }]), 'p:2');
});

test('two different elements do not collapse onto one id', () => {
  const first = styleIdFor([{ tag: 'button', classes: ['action'] }, { tag: 'div', classes: ['left'] }]);
  const second = styleIdFor([{ tag: 'button', classes: ['action'] }, { tag: 'div', classes: ['right'] }]);
  assert.notEqual(first, second);
});

test('an empty path is named rather than becoming an empty key', () => {
  // An empty string as a key would silently merge every unidentifiable element
  // into one entry, so every one of them would restyle together.
  assert.equal(styleIdFor([]), 'unknown');
});
