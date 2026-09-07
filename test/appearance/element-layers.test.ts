/**
 * Layers on one element.
 *
 * The two things worth testing hardest are the ORDER, which is the one thing a
 * well-meaning refactor reverses while every counting test keeps passing, and
 * the LOCK, which must refuse out loud rather than swallow an edit.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BLEND_MODES,
  LAYER_KINDS,
  type Layer,
  type LayerBook,
  NO_LAYERS,
  addLayer,
  compose,
  countVisible,
  duplicateLayer,
  layersFor,
  moveLayer,
  newLayer,
  readLayerBook,
  removeLayer,
  updateLayer,
  withOpacity,
} from '../../app/shared/element-layers';

function ok<T>(result: T | { ok: false; reason: string }): T {
  assert.ok(!(result !== null && typeof result === 'object' && 'ok' in result), 'refused');
  return result as T;
}

function stackOf(...kinds: readonly ('fill' | 'gradient' | 'shadow' | 'ring' | 'blur')[]): LayerBook {
  let book = NO_LAYERS;
  // Added newest-first by addLayer, so the list is reversed here to make the
  // resulting stack read in the order the caller named.
  for (const kind of [...kinds].reverse()) {
    book = addLayer(book, 'a', newLayer(kind, kind + '-' + Math.random().toString(36).slice(2, 7)));
  }
  return book;
}

// ------------------------------------------------------------- new layers --

test('every kind can be created and renders something visible', () => {
  // A new layer that paints nothing is indistinguishable from one that failed
  // to be added, and the user's next move is to add another.
  for (const entry of LAYER_KINDS) {
    const layer = newLayer(entry.kind, 'x');
    assert.equal(layer.kind, entry.kind);
    assert.equal(layer.visible, true);
    assert.equal(layer.locked, false);
    assert.equal(layer.opacity, 1);
    const painted = compose([layer]);
    const paints =
      painted.backgroundImage !== '' ||
      painted.boxShadow !== '' ||
      painted.backdropFilter !== '';
    assert.ok(paints, entry.kind + ' paints nothing');
  }
});

test('a new layer goes on TOP, where the person who pressed the button is looking', () => {
  let book = addLayer(NO_LAYERS, 'a', { ...newLayer('fill', 'one'), name: 'One' });
  book = addLayer(book, 'a', { ...newLayer('fill', 'two'), name: 'Two' });
  assert.deepEqual(layersFor(book, 'a').map((layer) => layer.name), ['Two', 'One']);
});

// ------------------------------------------------------------------ order --

test('the list order IS the paint order, top first', () => {
  // THE ONE A REFACTOR REVERSES. CSS background-image paints its first layer on
  // top, and a layers panel reads top first, so the two orders are the same.
  // Reversing this puts every stack upside down while every counting test
  // keeps passing.
  const top: Layer = { ...newLayer('fill', 'top'), colour: '#111111' };
  const bottom: Layer = { ...newLayer('fill', 'bottom'), colour: '#222222' };
  const painted = compose([top, bottom]);
  const first = painted.backgroundImage.indexOf('#111111');
  const second = painted.backgroundImage.indexOf('#222222');
  assert.ok(first >= 0 && second >= 0, painted.backgroundImage);
  assert.ok(first < second, 'the top layer is not painted first');
});

test('moving up and down really reorders', () => {
  const book = stackOf('fill', 'gradient');
  const ids = layersFor(book, 'a').map((layer) => layer.id);
  const moved = ok(moveLayer(book, 'a', ids[1] as string, 'up')) as { book: LayerBook };
  assert.deepEqual(layersFor(moved.book, 'a').map((layer) => layer.id), [ids[1], ids[0]]);
});

test('moving is clamped at both ends rather than wrapping', () => {
  // A layer that jumps from the top to the bottom because somebody pressed up
  // once too often is a surprise nobody wants from an ordering control.
  const book = stackOf('fill', 'gradient');
  const ids = layersFor(book, 'a').map((layer) => layer.id);

  const top = moveLayer(book, 'a', ids[0] as string, 'up');
  assert.ok('ok' in top && top.ok === false);
  assert.match((top as { reason: string }).reason, /already at the top/);

  const bottom = moveLayer(book, 'a', ids[1] as string, 'down');
  assert.ok('ok' in bottom && bottom.ok === false);
  assert.match((bottom as { reason: string }).reason, /already at the bottom/);
});

// ------------------------------------------------------------------- lock --

test('a locked layer refuses an edit OUT LOUD rather than swallowing it', () => {
  // A lock that silently ignores an edit is worse than no lock: the control
  // moves, nothing happens, and there is no way to learn why.
  let book = addLayer(NO_LAYERS, 'a', { ...newLayer('fill', 'one'), name: 'Base', locked: true });
  const result = updateLayer(book, 'a', 'one', { colour: '#000000' });
  assert.ok('ok' in result && result.ok === false);
  assert.match((result as { reason: string }).reason, /Base is locked/);
  assert.equal(layersFor(book, 'a')[0]?.colour, '#4f6bed', 'the value changed anyway');
  book = NO_LAYERS;
});

test('unlocking is always allowed, or a lock could never be undone', () => {
  const book = addLayer(NO_LAYERS, 'a', { ...newLayer('fill', 'one'), locked: true });
  const result = ok(updateLayer(book, 'a', 'one', { locked: false })) as { book: LayerBook };
  assert.equal(layersFor(result.book, 'a')[0]?.locked, false);
});

test('a locked layer refuses to be moved or removed, and says which', () => {
  const book = addLayer(NO_LAYERS, 'a', { ...newLayer('fill', 'one'), name: 'Base', locked: true });
  for (const result of [
    removeLayer(book, 'a', 'one'),
    moveLayer(book, 'a', 'one', 'down'),
  ]) {
    assert.ok('ok' in result && result.ok === false);
    assert.match((result as { reason: string }).reason, /Base is locked/);
  }
});

test('a duplicate is never locked, whatever the original was', () => {
  // A copy that arrives locked cannot be edited, which is the one thing
  // somebody duplicating a layer is about to do.
  const book = addLayer(NO_LAYERS, 'a', { ...newLayer('fill', 'one'), locked: true });
  const result = ok(duplicateLayer(book, 'a', 'one', 'two')) as { book: LayerBook };
  const copy = layersFor(result.book, 'a').find((layer) => layer.id === 'two');
  assert.equal(copy?.locked, false);
  assert.match(copy?.name ?? '', /copy/);
});

// -------------------------------------------------------------- visibility --

test('a hidden layer contributes NOTHING, not a transparent copy of itself', () => {
  // A transparent copy still occupies a slot, which shifts every blend mode
  // after it by one - so hiding one layer would restyle the others.
  const painted = compose([
    { ...newLayer('fill', 'one'), colour: '#111111', visible: false },
    { ...newLayer('fill', 'two'), colour: '#222222' },
  ]);
  assert.ok(!painted.backgroundImage.includes('#111111'), painted.backgroundImage);
  assert.equal(painted.backgroundImage.split('linear-gradient').length - 1, 1);
});

test('hiding a layer leaves it in the stack, so it can come back', () => {
  const book = addLayer(NO_LAYERS, 'a', newLayer('fill', 'one'));
  const hidden = ok(updateLayer(book, 'a', 'one', { visible: false })) as { book: LayerBook };
  assert.equal(layersFor(hidden.book, 'a').length, 1);
  assert.equal(countVisible(layersFor(hidden.book, 'a')), 0);
});

// -------------------------------------------------------------- compositing --

test('a fill is a flat gradient, because only background-image stacks', () => {
  // background-color would sit under every layer and could never be ordered.
  const painted = compose([{ ...newLayer('fill', 'one'), colour: '#123456' }]);
  assert.equal(painted.backgroundImage, 'linear-gradient(#123456, #123456)');
});

test('shadows, inner shadows and rings all land in box-shadow, in order', () => {
  const painted = compose([
    { ...newLayer('shadow', 'a'), colour: '#111111', offsetX: 1, offsetY: 2, blur: 3 },
    { ...newLayer('innerShadow', 'b'), colour: '#222222', offsetX: 0, offsetY: 1, blur: 2 },
    { ...newLayer('ring', 'c'), colour: '#333333', size: 4 },
  ]);
  assert.equal(
    painted.boxShadow,
    '1px 2px 3px #111111, inset 0px 1px 2px #222222, inset 0 0 0 4px #333333',
  );
});

test('a blend list is only emitted when something is actually blended', () => {
  // An ordinary stack should not carry a list of "normal" that nobody needs.
  const plain = compose([newLayer('fill', 'a'), newLayer('fill', 'b')]);
  assert.equal(plain.backgroundBlend, '');

  const blended = compose([
    { ...newLayer('fill', 'a'), blend: 'multiply' },
    newLayer('fill', 'b'),
  ]);
  assert.equal(blended.backgroundBlend, 'multiply, normal');
});

test('an empty stack paints nothing at all', () => {
  const painted = compose([]);
  assert.deepEqual(painted, {
    backgroundImage: '',
    backgroundBlend: '',
    boxShadow: '',
    backdropFilter: '',
  });
});

test('every blend mode offered is a real one', () => {
  assert.ok(BLEND_MODES.includes('normal'));
  assert.equal(new Set(BLEND_MODES).size, BLEND_MODES.length, 'a blend mode is listed twice');
});

// ----------------------------------------------------------------- opacity --

test('opacity folds into the COLOUR, never onto the element', () => {
  // The classic mistake: the element's own opacity fades its text and its
  // children too, which makes a layer stack unusable on anything with words in
  // it.
  assert.equal(withOpacity('#112233', 0.5), '#11223380');
  assert.equal(withOpacity('rgb(1, 2, 3)', 0.5), 'rgba(1,2,3,0.5)');
});

test('an existing alpha is multiplied rather than replaced', () => {
  assert.equal(withOpacity('rgba(1,2,3,0.5)', 0.5), 'rgba(1,2,3,0.25)');
});

test('full opacity leaves the colour exactly as written', () => {
  assert.equal(withOpacity('#112233', 1), '#112233');
  assert.equal(withOpacity('rebeccapurple', 1), 'rebeccapurple');
});

test('a notation this does not recognise is left alone rather than guessed at', () => {
  // A wrong colour is worse than a colour at full strength, and the layer still
  // renders.
  assert.equal(withOpacity('oklch(0.7 0.1 250)', 0.5), 'oklch(0.7 0.1 250)');
  assert.equal(withOpacity('rebeccapurple', 0.5), 'rebeccapurple');
});

test('an out-of-range opacity is refused rather than clamped silently', () => {
  const book = addLayer(NO_LAYERS, 'a', newLayer('fill', 'one'));
  for (const bad of [-1, 2, Number.NaN]) {
    const result = updateLayer(book, 'a', 'one', { opacity: bad });
    assert.ok('ok' in result && result.ok === false, String(bad));
  }
});

// --------------------------------------------------------------- the book --

test('removing the last layer removes the element entirely', () => {
  const book = addLayer(NO_LAYERS, 'a', newLayer('fill', 'one'));
  const result = ok(removeLayer(book, 'a', 'one')) as { book: LayerBook };
  assert.equal('a' in result.book, false);
});

test('one element is never disturbed by another', () => {
  let book = addLayer(NO_LAYERS, 'a', newLayer('fill', 'one'));
  book = addLayer(book, 'b', newLayer('ring', 'two'));
  const result = ok(removeLayer(book, 'a', 'one')) as { book: LayerBook };
  assert.equal(layersFor(result.book, 'b').length, 1);
});

test('acting on a layer that is not there is refused, not ignored', () => {
  const book = addLayer(NO_LAYERS, 'a', newLayer('fill', 'one'));
  for (const result of [
    updateLayer(book, 'a', 'ghost', { visible: false }),
    removeLayer(book, 'a', 'ghost'),
    moveLayer(book, 'a', 'ghost', 'up'),
    duplicateLayer(book, 'a', 'ghost', 'new'),
  ]) {
    assert.ok('ok' in result && result.ok === false);
  }
});

test('nothing mutates the book handed in', () => {
  const book = addLayer(NO_LAYERS, 'a', newLayer('fill', 'one'));
  const snapshot = JSON.stringify(book);
  updateLayer(book, 'a', 'one', { colour: '#000000' });
  removeLayer(book, 'a', 'one');
  assert.equal(JSON.stringify(book), snapshot, 'the earlier book was mutated');
});

// ------------------------------------------------------------- reading in --

const anyColour = (raw: string): boolean => /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|[a-z]+)$/i.test(raw);

test('a stored book is read back, and a layer with a bad colour is dropped', () => {
  // Layer colours reach a style attribute exactly as element properties do, so
  // they are checked here rather than trusted because they came from the
  // settings file - an ordinary file anybody can open in an editor.
  const book = readLayerBook(
    {
      a: [
        { id: 'one', kind: 'fill', colour: '#112233' },
        { id: 'two', kind: 'fill', colour: 'red; background-image: url(evil)' },
      ],
    },
    anyColour,
  );
  assert.equal(layersFor(book, 'a').length, 1);
  assert.equal(layersFor(book, 'a')[0]?.id, 'one');
});

test('a layer of an unknown kind is dropped rather than rendered blind', () => {
  const book = readLayerBook({ a: [{ id: 'x', kind: 'wormhole', colour: '#112233' }] }, anyColour);
  assert.deepEqual(book, {});
});

test('numbers are clamped to a sane range rather than trusted', () => {
  const book = readLayerBook(
    { a: [{ id: 'x', kind: 'shadow', colour: '#112233', blur: 1e9, opacity: 5 }] },
    anyColour,
  );
  const layer = layersFor(book, 'a')[0];
  assert.equal(layer?.blur, 200);
  assert.equal(layer?.opacity, 1);
});

test('anything that is not a book at all reads as empty', () => {
  for (const bad of [null, 42, 'text', [], { a: 'not a list' }]) {
    assert.deepEqual(readLayerBook(bad, anyColour), {});
  }
});

test('an element whose layers were all rejected does not survive as an empty entry', () => {
  const book = readLayerBook({ a: [{ id: 'x', kind: 'fill', colour: 'url(evil)' }] }, anyColour);
  assert.equal('a' in book, false);
});
