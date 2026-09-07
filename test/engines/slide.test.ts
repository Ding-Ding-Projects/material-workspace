/**
 * Slide engine conformance.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GEOMETRY,
  LAYOUTS,
  type Presentation,
  clampFrame,
  emptyPresentation,
  fontSizeToPixels,
  frameToPixels,
  newSlide,
  slideTitle,
  totalDuration,
  visibleSlides,
} from '../../app/engines/slide/model';

test('a new presentation starts with one title slide, ready to type into', () => {
  const presentation = emptyPresentation();
  assert.equal(presentation.slides.length, 1);
  assert.equal(presentation.slides[0]?.layout, 'title');
  // Placeholders exist so there is somewhere to type. A blank slide with no
  // elements is an editor with nothing to click.
  assert.equal(presentation.slides[0]?.elements.length, 2);
});

test('every layout places its placeholders inside the slide', () => {
  // A placeholder positioned partly off the slide renders half a title and
  // looks like a rendering fault rather than a layout mistake.
  for (const [name, placeholders] of Object.entries(LAYOUTS)) {
    for (const placeholder of placeholders) {
      const { x, y, width, height } = placeholder.frame;
      assert.ok(x >= 0 && y >= 0, name + ' starts off the slide');
      assert.ok(x + width <= 1.0001, name + ' overflows to the right');
      assert.ok(y + height <= 1.0001, name + ' overflows past the bottom');
    }
  }
});

test('two-content placeholders do not overlap each other', () => {
  const [, left, right] = LAYOUTS.twoContent;
  assert.ok(left && right);
  assert.ok(
    left.frame.x + left.frame.width <= right.frame.x,
    'the two content columns overlap, so text would render on top of text',
  );
});

test('normalised coordinates scale exactly to any rendered size', () => {
  const frame = { x: 0.25, y: 0.5, width: 0.5, height: 0.25 };
  const small = frameToPixels(frame, 640, 360);
  const large = frameToPixels(frame, 1920, 1080);
  assert.deepEqual(small, { left: 160, top: 180, width: 320, height: 90 });
  assert.deepEqual(large, { left: 480, top: 540, width: 960, height: 270 });
  // Exactly three times, with no rounding drift. That is the whole reason the
  // model stores ratios rather than pixels.
  assert.equal(large.left / small.left, 3);
  assert.equal(large.width / small.width, 3);
});

test('font size scales with the slide, so a laptop deck is readable on a projector', () => {
  const geometry = GEOMETRY['16:9'];
  assert.equal(fontSizeToPixels(40, geometry.width, geometry), 40);
  assert.equal(fontSizeToPixels(40, geometry.width * 2, geometry), 80);
  assert.equal(fontSizeToPixels(40, geometry.width / 2, geometry), 20);
});

test('a frame is clamped into the slide rather than allowed off it', () => {
  assert.deepEqual(clampFrame({ x: -0.5, y: -0.5, width: 0.3, height: 0.3 }), {
    x: 0,
    y: 0,
    width: 0.3,
    height: 0.3,
  });
  // Pushed back so the whole element stays visible, not just its corner.
  assert.deepEqual(clampFrame({ x: 0.9, y: 0.9, width: 0.3, height: 0.3 }), {
    x: 0.7,
    y: 0.7,
    width: 0.3,
    height: 0.3,
  });
  // An element cannot be shrunk to nothing and become unclickable.
  const tiny = clampFrame({ x: 0.5, y: 0.5, width: 0, height: 0 });
  assert.ok(tiny.width > 0 && tiny.height > 0);
});

test('a slide title comes from its title element, then from any text', () => {
  const slide = newSlide('titleAndContent');
  assert.equal(slideTitle(slide, 6), 'Slide 7');

  const titled = {
    ...slide,
    elements: slide.elements.map((element) =>
      element.kind === 'text' && element.role === 'title'
        ? { ...element, text: 'Dim sum' }
        : element,
    ),
  };
  assert.equal(slideTitle(titled, 6), 'Dim sum');

  // No title, but body text: better than "Slide 7" for finding it again.
  const bodyOnly = {
    ...slide,
    elements: slide.elements.map((element) =>
      element.kind === 'text' && element.role === 'body'
        ? { ...element, text: 'first line\nsecond line' }
        : element,
    ),
  };
  assert.equal(slideTitle(bodyOnly, 6), 'first line');
});

test('a hidden slide stays in the file and is skipped when presenting', () => {
  const presentation: Presentation = {
    schema: 'material-workspace/slides@1',
    size: '16:9',
    slides: [
      { ...newSlide('title'), hidden: false },
      { ...newSlide('title'), hidden: true },
      { ...newSlide('title'), hidden: false },
    ],
  };
  assert.equal(presentation.slides.length, 3);
  assert.equal(visibleSlides(presentation).length, 2);
});

test('a total duration is undefined when any slide waits for a keypress', () => {
  // Treating a keypress-advanced slide as zero would tell a presenter their
  // forty-minute talk takes four minutes, which is worse than no number.
  const timed: Presentation = {
    schema: 'material-workspace/slides@1',
    size: '16:9',
    slides: [
      { ...newSlide('title'), advanceAfter: 30 },
      { ...newSlide('title'), advanceAfter: 45 },
    ],
  };
  assert.equal(totalDuration(timed), 75);

  const mixed: Presentation = {
    ...timed,
    slides: [timed.slides[0] as never, { ...newSlide('title'), advanceAfter: 0 }],
  };
  assert.equal(totalDuration(mixed), undefined);
});

test('a hidden slide does not count toward the duration', () => {
  const presentation: Presentation = {
    schema: 'material-workspace/slides@1',
    size: '16:9',
    slides: [
      { ...newSlide('title'), advanceAfter: 30 },
      { ...newSlide('title'), advanceAfter: 999, hidden: true },
    ],
  };
  assert.equal(totalDuration(presentation), 30);
});

test('both slide sizes have the ratio they claim', () => {
  assert.equal(GEOMETRY['16:9'].width / GEOMETRY['16:9'].height, 16 / 9);
  assert.equal(GEOMETRY['4:3'].width / GEOMETRY['4:3'].height, 4 / 3);
});
