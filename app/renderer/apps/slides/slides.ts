/**
 * Slides.
 *
 * Two surfaces over one model: an editor, and a presenter view.
 *
 * THE PRESENTER VIEW IS THE HARD PART, and it is where presentation software
 * most often disappoints. The presenter needs the current slide, the NEXT one,
 * the speaker notes and a clock; the audience must see the current slide and
 * nothing else. Getting that wrong shows a room full of people the notes the
 * presenter was reading from, which is the single most embarrassing failure
 * this application can have.
 *
 * So the two are separate renderings of the same model rather than one view
 * with things hidden by CSS. A hidden-by-CSS note is one stylesheet mistake
 * away from being on the projector, and it is already in the DOM for anyone
 * who looks.
 */

import { clear, el } from '../../dom.js';
import {
  GEOMETRY,
  LAYOUTS,
  type LayoutName,
  type Presentation,
  type Slide,
  type SlideElement,
  clampFrame,
  emptyPresentation,
  fontSizeToPixels,
  frameToPixels,
  newElementId,
  newSlide,
  slideTitle,
  totalDuration,
  visibleSlides,
} from '../../../engines/slide/model.js';

export interface SlidesOptions {
  presentation?: Presentation;
  onChange?: (presentation: Presentation) => void;
}

const LAYOUT_LABELS: readonly { layout: LayoutName; label: string }[] = [
  { layout: 'title', label: 'Title' },
  { layout: 'titleAndContent', label: 'Title and content' },
  { layout: 'twoContent', label: 'Two content' },
  { layout: 'sectionHeader', label: 'Section header' },
  { layout: 'blank', label: 'Blank' },
];

export class Slides {
  readonly element: HTMLElement;

  private presentation: Presentation;
  private readonly options: SlidesOptions;

  private current = 0;
  private selectedElement: string | null = null;
  private presenting = false;
  private startedAt: number | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;

  private readonly slideList: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly notesInput: HTMLTextAreaElement;
  private readonly toolbar: HTMLElement;
  private readonly statusLine: HTMLElement;
  private readonly presenterHost: HTMLElement;

  constructor(options: SlidesOptions = {}) {
    this.options = options;
    this.presentation = options.presentation ?? emptyPresentation();

    this.slideList = el('div', {
      class: 'slides__list',
      role: 'listbox',
      'aria-label': 'Slides',
      tabindex: '0',
    });

    this.stage = el('div', {
      class: 'slides__stage',
      role: 'group',
      'aria-label': 'Current slide',
    });

    this.notesInput = el('textarea', {
      class: 'slides__notes',
      'aria-label': 'Speaker notes for this slide',
      placeholder: 'Notes only you will see while presenting',
      rows: '3',
    }) as HTMLTextAreaElement;

    this.toolbar = el('div', { class: 'slides__toolbar', role: 'toolbar', 'aria-label': 'Slides' });
    this.statusLine = el('div', {
      class: 'slides__status',
      role: 'status',
      'aria-live': 'polite',
    });

    this.presenterHost = el('div', {
      class: 'slides__presenter',
      'data-presenting': 'false',
    });

    this.element = el('div', { class: 'slides' }, [
      this.toolbar,
      el('div', { class: 'slides__body' }, [
        this.slideList,
        el('div', { class: 'slides__main' }, [
          this.stage,
          el('label', { class: 'slides__notes-wrap' }, [
            el('span', { class: 'slides__notes-label' }, ['Speaker notes']),
            this.notesInput,
          ]),
        ]),
      ]),
      this.statusLine,
      this.presenterHost,
    ]);

    this.buildToolbar();
    this.wire();
    this.render();
  }

  /** Stop the clock when the surface goes away, or it ticks forever. */
  dispose(): void {
    if (this.tick !== null) {
      clearInterval(this.tick);
      this.tick = null;
    }
  }

  private buildToolbar(): void {
    clear(this.toolbar);

    const select = el('select', {
      class: 'slides__layout',
      'aria-label': 'Layout for a new slide',
    }) as HTMLSelectElement;
    for (const entry of LAYOUT_LABELS) {
      select.append(el('option', { value: entry.layout, text: entry.label }));
    }
    select.value = 'titleAndContent';
    this.toolbar.append(select);

    const button = (
      label: string,
      action: string,
      title: string,
      shortcut?: string,
    ): HTMLElement => {
      const node = el(
        'button',
        {
          class: 'slides__action',
          type: 'button',
          'data-action': action,
          // The shortcut that ACTUALLY works, shown where people look for it.
          title: shortcut === undefined ? title : title + '  ' + shortcut,
          ...(shortcut === undefined ? {} : { 'aria-keyshortcuts': shortcut }),
        },
        [label],
      );
      this.toolbar.append(node);
      return node;
    };

    button('Add slide', 'add', 'Add a slide with the chosen layout');
    button('Duplicate', 'duplicate', 'Duplicate the current slide');
    button('Delete', 'delete', 'Delete the current slide');
    button('Add text box', 'add-text', 'Add a text box to this slide');
    button('Hide', 'hide', 'Hide this slide from the presentation, keeping it in the file');
    button('Present', 'present', 'Start presenting from this slide', 'F5');
  }

  private wire(): void {
    this.toolbar.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('.slides__action');
      if (!target) return;
      this.runAction(target.getAttribute('data-action') ?? '');
    });

    this.slideList.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('.slides__thumb');
      if (!target) return;
      this.current = Number(target.getAttribute('data-index') ?? '0');
      this.selectedElement = null;
      this.render();
    });

    this.slideList.addEventListener('keydown', (event) => {
      const keyboard = event as KeyboardEvent;
      if (keyboard.key === 'ArrowDown' || keyboard.key === 'ArrowUp') {
        event.preventDefault();
        this.goTo(this.current + (keyboard.key === 'ArrowDown' ? 1 : -1));
      }
    });

    this.notesInput.addEventListener('input', () => {
      this.updateSlide((slide) => ({ ...slide, notes: this.notesInput.value }));
      // Deliberately not a full render: rebuilding the DOM under a focused
      // textarea moves the caret to the end on every keystroke.
      this.renderStatus();
      this.options.onChange?.(this.presentation);
    });

    // Presenting is keyboard-driven, and the keys are the ones every other
    // presentation tool uses. Inventing new ones here would be a small,
    // constant tax on everybody who has ever presented before.
    this.element.addEventListener('keydown', (event) => {
      const keyboard = event as KeyboardEvent;
      if (keyboard.key === 'F5') {
        event.preventDefault();
        this.startPresenting();
        return;
      }
      if (!this.presenting) return;

      if (keyboard.key === 'Escape') {
        event.preventDefault();
        this.stopPresenting();
      } else if (
        keyboard.key === 'ArrowRight' ||
        keyboard.key === 'ArrowDown' ||
        keyboard.key === 'PageDown' ||
        keyboard.key === ' '
      ) {
        event.preventDefault();
        this.advance(1);
      } else if (
        keyboard.key === 'ArrowLeft' ||
        keyboard.key === 'ArrowUp' ||
        keyboard.key === 'PageUp'
      ) {
        event.preventDefault();
        this.advance(-1);
      }
    });

    this.stage.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('.slides__element');
      this.selectedElement = target?.getAttribute('data-element') ?? null;
      this.render();
    });

    this.stage.addEventListener('input', (event) => {
      const target = event.target as HTMLElement;
      const id = target.getAttribute('data-element');
      if (id === null) return;
      const text = target.textContent ?? '';
      this.updateSlide((slide) => ({
        ...slide,
        elements: slide.elements.map((element) =>
          element.id === id && element.kind === 'text' ? { ...element, text } : element,
        ),
      }));
      // Again, no full render: this element is being typed into.
      this.renderThumbnails();
      this.renderStatus();
      this.options.onChange?.(this.presentation);
    });
  }

  private runAction(action: string): void {
    const select = this.toolbar.querySelector<HTMLSelectElement>('.slides__layout');
    switch (action) {
      case 'add': {
        const layout = (select?.value ?? 'titleAndContent') as LayoutName;
        const slides = [...this.presentation.slides];
        slides.splice(this.current + 1, 0, newSlide(layout));
        this.presentation = { ...this.presentation, slides };
        this.current += 1;
        break;
      }
      case 'duplicate': {
        const source = this.presentation.slides[this.current];
        if (source === undefined) return;
        const slides = [...this.presentation.slides];
        // New ids throughout. Sharing an id makes editing one copy edit both,
        // which reads as the application randomly changing a slide nobody
        // touched.
        slides.splice(this.current + 1, 0, {
          ...source,
          id: newSlide('blank').id,
          elements: source.elements.map((element) => ({ ...element, id: newElementId() })),
        });
        this.presentation = { ...this.presentation, slides };
        this.current += 1;
        break;
      }
      case 'delete': {
        if (this.presentation.slides.length <= 1) {
          this.setStatus('A presentation must keep at least one slide.');
          return;
        }
        const slides = this.presentation.slides.filter((_, index) => index !== this.current);
        this.presentation = { ...this.presentation, slides };
        this.current = Math.min(this.current, slides.length - 1);
        break;
      }
      case 'add-text': {
        this.updateSlide((slide) => ({
          ...slide,
          elements: [
            ...slide.elements,
            {
              kind: 'text',
              id: newElementId(),
              // Placed a little in from the corner rather than at 0,0, so a
              // new box is never hidden under the slide's own edge.
              frame: clampFrame({ x: 0.15, y: 0.4, width: 0.5, height: 0.15 }),
              text: '',
              role: 'body',
              style: { size: 20 },
            },
          ],
        }));
        break;
      }
      case 'hide': {
        this.updateSlide((slide) => ({ ...slide, hidden: !slide.hidden }));
        break;
      }
      case 'present':
        this.startPresenting();
        return;
      default:
        return;
    }

    this.selectedElement = null;
    this.options.onChange?.(this.presentation);
    this.render();
  }

  private updateSlide(change: (slide: Slide) => Slide): void {
    const slides = this.presentation.slides.map((slide, index) =>
      index === this.current ? change(slide) : slide,
    );
    this.presentation = { ...this.presentation, slides };
  }

  private goTo(index: number): void {
    const bounded = Math.min(Math.max(index, 0), this.presentation.slides.length - 1);
    if (bounded === this.current) return;
    this.current = bounded;
    this.selectedElement = null;
    this.render();
  }

  // ------------------------------------------------------------ presenting --

  private startPresenting(): void {
    const visible = visibleSlides(this.presentation);
    if (visible.length === 0) {
      this.setStatus('Every slide is hidden, so there is nothing to present.');
      return;
    }
    this.presenting = true;
    this.startedAt = performance.now();
    // The clock is the presenter's, so it ticks while presenting and not
    // otherwise. A timer left running is a wakeup every second forever.
    this.tick = setInterval(() => this.renderPresenterClock(), 1000);
    this.renderPresenter();
    this.presenterHost.focus();
  }

  private stopPresenting(): void {
    this.presenting = false;
    this.startedAt = null;
    if (this.tick !== null) {
      clearInterval(this.tick);
      this.tick = null;
    }
    this.renderPresenter();
    this.render();
  }

  private advance(direction: number): void {
    const visible = visibleSlides(this.presentation);
    const currentSlide = this.presentation.slides[this.current];
    const position = currentSlide === undefined ? 0 : visible.indexOf(currentSlide);
    const next = Math.min(Math.max(position + direction, 0), visible.length - 1);
    const target = visible[next];
    if (target === undefined) return;
    this.current = this.presentation.slides.indexOf(target);
    this.renderPresenter();
  }

  // ------------------------------------------------------------- rendering --

  private render(): void {
    this.renderThumbnails();
    this.renderStage();
    this.renderNotes();
    this.renderStatus();
    this.renderPresenter();
  }

  private renderThumbnails(): void {
    clear(this.slideList);
    this.presentation.slides.forEach((slide, index) => {
      const thumb = el(
        'div',
        {
          class: 'slides__thumb',
          role: 'option',
          'data-index': String(index),
          'data-current': index === this.current ? 'true' : 'false',
          'data-hidden': slide.hidden ? 'true' : 'false',
          'aria-selected': index === this.current ? 'true' : 'false',
        },
        [
          el('span', { class: 'slides__thumb-number' }, [String(index + 1)]),
          el('span', { class: 'slides__thumb-title' }, [slideTitle(slide, index)]),
          // Hidden state is stated in TEXT, not only by a dimmed style. A
          // colour alone is invisible to a screen reader and to anyone who
          // cannot distinguish it.
          ...(slide.hidden ? [el('span', { class: 'slides__thumb-hidden' }, ['Hidden'])] : []),
        ],
      );
      this.slideList.append(thumb);
    });
  }

  private renderStage(): void {
    clear(this.stage);
    const slide = this.presentation.slides[this.current];
    if (slide === undefined) return;

    const geometry = GEOMETRY[this.presentation.size];
    const surface = el('div', {
      class: 'slides__surface',
      'data-layout': slide.layout,
      // The aspect ratio is a property of the model, so it is set from the
      // model rather than fixed in the stylesheet — a 4:3 deck must render 4:3.
      style: 'aspect-ratio:' + geometry.width + '/' + geometry.height,
    });

    for (const element of slide.elements) {
      surface.append(this.renderElement(element, slide));
    }
    this.stage.append(surface);
  }

  private renderElement(element: SlideElement, slide: Slide): HTMLElement {
    // Percentages, so the element scales with whatever size the stage happens
    // to be. Pixels computed here would be wrong the moment the window moves.
    const style =
      'left:' +
      element.frame.x * 100 +
      '%;top:' +
      element.frame.y * 100 +
      '%;width:' +
      element.frame.width * 100 +
      '%;height:' +
      element.frame.height * 100 +
      '%';

    if (element.kind === 'text') {
      const placeholder =
        element.role === 'title'
          ? 'Title'
          : element.role === 'subtitle'
            ? 'Subtitle'
            : 'Text';
      const node = el('div', {
        class: 'slides__element slides__element--text',
        'data-element': element.id,
        'data-role': element.role ?? 'body',
        'data-selected': this.selectedElement === element.id ? 'true' : 'false',
        'data-empty': element.text === '' ? 'true' : 'false',
        contenteditable: 'true',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': placeholder + ' on slide ' + (this.current + 1),
        'data-placeholder': placeholder,
        style:
          style +
          ';font-size:' +
          // Relative to the stage width, which is what makes text scale with
          // the slide rather than staying laptop-sized on a projector.
          ((element.style.size ?? 20) / GEOMETRY[this.presentation.size].width) * 100 +
          'cqw' +
          (element.style.bold === true ? ';font-weight:700' : '') +
          (element.style.italic === true ? ';font-style:italic' : '') +
          (element.style.align !== undefined ? ';text-align:' + element.style.align : ''),
      });
      node.textContent = element.text;
      return node;
    }

    if (element.kind === 'image') {
      return el('img', {
        class: 'slides__element slides__element--image',
        'data-element': element.id,
        src: element.source,
        // Alt text is required by the model, so an image without a description
        // cannot be created in the first place.
        alt: element.alt,
        style,
      });
    }

    return el('div', {
      class: 'slides__element slides__element--shape',
      'data-element': element.id,
      'data-shape': element.shape,
      'aria-hidden': 'true',
      style: style + (element.fill !== undefined ? ';background:' + element.fill : ''),
    });
  }

  private renderNotes(): void {
    const slide = this.presentation.slides[this.current];
    if (slide === undefined) return;
    // Never overwrite while it is being typed into.
    if (document.activeElement !== this.notesInput) {
      this.notesInput.value = slide.notes;
    }
  }

  private renderStatus(): void {
    const total = totalDuration(this.presentation);
    const visible = visibleSlides(this.presentation).length;
    const hidden = this.presentation.slides.length - visible;

    this.setStatus(
      'Slide ' +
        (this.current + 1) +
        ' of ' +
        this.presentation.slides.length +
        (hidden > 0 ? '   ' + hidden + ' hidden' : '') +
        '   ' +
        this.presentation.size +
        (total === undefined
          ? '   Timing: advances on a keypress'
          : '   Runs ' + formatDuration(total)),
    );
  }

  private setStatus(message: string): void {
    clear(this.statusLine);
    this.statusLine.append(message);
  }

  /**
   * The presenter view.
   *
   * Built as its own DOM rather than by hiding parts of the editor. A note
   * hidden with CSS is one stylesheet mistake away from the projector, and it
   * is already in the document for anyone who looks.
   */
  private renderPresenter(): void {
    clear(this.presenterHost);
    this.presenterHost.setAttribute('data-presenting', this.presenting ? 'true' : 'false');
    if (!this.presenting) {
      this.presenterHost.removeAttribute('tabindex');
      return;
    }
    this.presenterHost.setAttribute('tabindex', '-1');

    const visible = visibleSlides(this.presentation);
    const slide = this.presentation.slides[this.current];
    const position = slide === undefined ? 0 : visible.indexOf(slide);
    const next = visible[position + 1];

    const geometry = GEOMETRY[this.presentation.size];
    const ratio = 'aspect-ratio:' + geometry.width + '/' + geometry.height;

    const previewOf = (source: Slide | undefined, label: string): HTMLElement => {
      const surface = el('div', { class: 'slides__surface', style: ratio });
      if (source === undefined) {
        surface.append(el('div', { class: 'slides__end' }, ['End of the presentation']));
      } else {
        for (const element of source.elements) {
          if (element.kind !== 'text') continue;
          surface.append(
            el(
              'div',
              {
                class: 'slides__element slides__element--text',
                'data-role': element.role ?? 'body',
                style:
                  'left:' +
                  element.frame.x * 100 +
                  '%;top:' +
                  element.frame.y * 100 +
                  '%;width:' +
                  element.frame.width * 100 +
                  '%;height:' +
                  element.frame.height * 100 +
                  '%;font-size:' +
                  ((element.style.size ?? 20) / geometry.width) * 100 +
                  'cqw' +
                  (element.style.bold === true ? ';font-weight:700' : ''),
              },
              [element.text],
            ),
          );
        }
      }
      return el('div', { class: 'slides__preview' }, [
        el('span', { class: 'slides__preview-label' }, [label]),
        surface,
      ]);
    };

    this.presenterHost.append(
      el('div', { class: 'slides__presenter-bar' }, [
        el('span', { class: 'slides__clock', 'data-clock': 'true' }, ['0:00']),
        el('span', { class: 'slides__presenter-position' }, [
          'Slide ' + (position + 1) + ' of ' + visible.length,
        ]),
        el(
          'button',
          {
            class: 'slides__action',
            type: 'button',
            'data-action': 'stop',
            title: 'Stop presenting  Esc',
            'aria-keyshortcuts': 'Escape',
          },
          ['Stop presenting'],
        ),
      ]),
      el('div', { class: 'slides__presenter-grid' }, [
        previewOf(slide, 'Now'),
        previewOf(next, 'Next'),
      ]),
      el('div', { class: 'slides__presenter-notes' }, [
        el('h3', {}, ['Speaker notes']),
        el('p', { class: 'slides__presenter-notes-body' }, [
          slide?.notes.trim() === '' || slide === undefined
            ? 'No notes for this slide.'
            : slide.notes,
        ]),
      ]),
    );

    const stop = this.presenterHost.querySelector('.slides__action[data-action="stop"]');
    stop?.addEventListener('click', () => this.stopPresenting());
    this.renderPresenterClock();
  }

  private renderPresenterClock(): void {
    const clock = this.presenterHost.querySelector('[data-clock="true"]');
    if (clock === null || this.startedAt === null) return;
    clock.textContent = formatDuration(Math.floor((performance.now() - this.startedAt) / 1000));
  }
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes + ':' + String(rest).padStart(2, '0');
}
