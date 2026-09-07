/**
 * The layers panel for one element.
 *
 * An ordered stack of decorations, each one hideable, lockable, reorderable,
 * duplicable, with its own opacity and blend mode - and nothing in it
 * destructive, because a layer that is switched off is still in the list and
 * still carries every value it had.
 *
 * THE LIST READS TOP FIRST, exactly as the paint order does. It is not
 * reversed anywhere, and the model's own test says so, because reversing it is
 * the change that puts every stack upside down while every counting test keeps
 * passing.
 *
 * WHAT IT IS NOT. There are no pixels here, so there is no brush, no eraser,
 * and no arbitrary mask - a mask is the element's own shape, because an element
 * has exactly one. The alternative would be rendering the element to a canvas
 * and showing a picture where the control used to be, which takes its
 * accessible name, its focus ring and its selectable text with it.
 */

import {
  BLEND_MODES,
  type BlendMode,
  LAYER_KINDS,
  type Layer,
  type LayerBook,
  type LayerKind,
  addLayer,
  duplicateLayer,
  layersFor,
  moveLayer,
  newLayer,
  removeLayer,
  updateLayer,
} from '../../shared/element-layers.js';
import { el } from '../dom.js';

export interface LayerPanelOptions {
  readonly elementId: string;
  readonly book: LayerBook;
  readonly onChange: (book: LayerBook) => void;
  /** Reported in words above the list. Never a red border on its own. */
  readonly onProblem: (message: string | null) => void;
  /** Injected so a test does not depend on a clock or a random source. */
  readonly nextId?: () => string;
}

export class LayerPanel {
  readonly element: HTMLElement;

  private readonly list: HTMLElement;
  private book: LayerBook;
  private counter = 0;

  constructor(private readonly options: LayerPanelOptions) {
    this.book = options.book;
    this.list = el('div', {
      class: 'layer-panel__list',
      role: 'list',
      'aria-label': 'Layers, topmost first',
    });

    this.element = el('section', { class: 'layer-panel', 'aria-label': 'Layers' }, [
      el('h3', { class: 'element-appearance__group' }, ['Layers']),
      this.addRow(),
      this.list,
    ]);

    this.render();
  }

  /** Replace the whole book, for when the editor was pointed at another element. */
  setBook(book: LayerBook): void {
    this.book = book;
    this.render();
  }

  private id(): string {
    if (this.options.nextId !== undefined) return this.options.nextId();
    this.counter += 1;
    return 'layer-' + this.counter + '-' + this.options.elementId.replace(/[^a-z0-9]/gi, '');
  }

  private addRow(): HTMLElement {
    const select = el('select', {
      class: 'layer-panel__kind',
      'aria-label': 'Kind of layer to add',
    }) as HTMLSelectElement;
    for (const entry of LAYER_KINDS) {
      select.append(el('option', { value: entry.kind }, [entry.label]));
    }

    const add = el(
      'button',
      { class: 'layer-panel__add', type: 'button', 'data-layer-action': 'add' },
      ['Add layer'],
    );
    add.addEventListener('click', () => {
      this.commit(
        addLayer(this.book, this.options.elementId, newLayer(select.value as LayerKind, this.id())),
      );
    });

    return el('div', { class: 'layer-panel__add-row' }, [select, add]);
  }

  private commit(book: LayerBook): void {
    this.book = book;
    this.options.onChange(book);
    this.render();
  }

  /** Apply a change, reporting a refusal in words instead of swallowing it. */
  private attempt(result: { book: LayerBook } | { ok: false; reason: string }): void {
    if ('ok' in result) {
      this.options.onProblem(result.reason);
      return;
    }
    this.options.onProblem(null);
    this.commit(result.book);
  }

  private render(): void {
    while (this.list.firstChild) this.list.firstChild.remove();

    const layers = layersFor(this.book, this.options.elementId);
    if (layers.length === 0) {
      // An honest empty state rather than an empty box, which reads as a panel
      // that failed to load.
      this.list.append(
        el('p', { class: 'element-appearance__origin' }, [
          'No layers on this element. Add one above; the newest sits on top.',
        ]),
      );
      return;
    }

    layers.forEach((layer, index) => {
      this.list.append(this.renderLayer(layer, index, layers.length));
    });
  }

  private renderLayer(layer: Layer, index: number, total: number): HTMLElement {
    const row = el('div', {
      class: 'layer-panel__layer',
      role: 'listitem',
      'data-layer': layer.id,
      'data-kind': layer.kind,
      'data-visible': layer.visible ? 'yes' : 'no',
      'data-locked': layer.locked ? 'yes' : 'no',
    });

    const name = el('input', {
      class: 'layer-panel__name',
      type: 'text',
      value: layer.name,
      'aria-label': 'Name of layer ' + (index + 1),
      ...(layer.locked ? { disabled: true, title: 'This layer is locked.' } : {}),
    }) as HTMLInputElement;
    name.addEventListener('change', () => {
      this.attempt(updateLayer(this.book, this.options.elementId, layer.id, { name: name.value }));
    });

    row.append(
      el('div', { class: 'layer-panel__head' }, [
        // Position stated in words as well as by order, so a screen reader
        // hears where in the stack this sits.
        el('span', { class: 'layer-panel__position' }, [index + 1 + ' of ' + total]),
        name,
        this.toggle(layer, 'visible', layer.visible ? 'Hide' : 'Show'),
        this.toggle(layer, 'locked', layer.locked ? 'Unlock' : 'Lock'),
        this.action(layer, 'up', 'Move up', index === 0),
        this.action(layer, 'down', 'Move down', index === total - 1),
        this.action(layer, 'duplicate', 'Duplicate', false),
        this.action(layer, 'remove', 'Remove', false),
      ]),
      this.controls(layer),
    );

    return row;
  }

  private toggle(layer: Layer, field: 'visible' | 'locked', label: string): HTMLElement {
    const button = el(
      'button',
      {
        class: 'layer-panel__toggle',
        type: 'button',
        'data-layer-toggle': field,
        // A pressed state on a real control, and the label says which way it
        // will go. An icon alone is invisible to a screen reader.
        'aria-pressed': layer[field] ? 'true' : 'false',
        'aria-label': label + ' ' + layer.name,
      },
      [label],
    );
    button.addEventListener('click', () => {
      this.attempt(
        updateLayer(this.book, this.options.elementId, layer.id, { [field]: !layer[field] }),
      );
    });
    return button;
  }

  private action(
    layer: Layer,
    action: 'up' | 'down' | 'duplicate' | 'remove',
    label: string,
    atEnd: boolean,
  ): HTMLElement {
    const button = el(
      'button',
      {
        class: 'layer-panel__action',
        type: 'button',
        'data-layer-action': action,
        'aria-label': label + ' ' + layer.name,
        // Disabled at the end of the stack with the reason on the control, so
        // it reads as blocked rather than broken.
        ...(atEnd
          ? { disabled: true, title: 'Already at the ' + (action === 'up' ? 'top' : 'bottom') }
          : {}),
      },
      [label],
    );

    button.addEventListener('click', () => {
      if (action === 'remove') {
        this.attempt(removeLayer(this.book, this.options.elementId, layer.id));
      } else if (action === 'duplicate') {
        this.attempt(duplicateLayer(this.book, this.options.elementId, layer.id, this.id()));
      } else {
        this.attempt(moveLayer(this.book, this.options.elementId, layer.id, action));
      }
    });
    return button;
  }

  private controls(layer: Layer): HTMLElement {
    const controls: HTMLElement[] = [
      this.colour(layer, 'colour', 'Colour'),
      this.slider(layer, 'opacity', 'Opacity', 0, 1, 0.05),
      this.blend(layer),
    ];

    if (layer.kind === 'gradient') {
      controls.push(
        this.colour(layer, 'colourTwo', 'Second colour'),
        this.slider(layer, 'angle', 'Angle', -360, 360, 5),
      );
    }
    if (layer.kind === 'shadow' || layer.kind === 'innerShadow') {
      controls.push(
        this.slider(layer, 'offsetX', 'Across', -100, 100, 1),
        this.slider(layer, 'offsetY', 'Down', -100, 100, 1),
        this.slider(layer, 'blur', 'Blur', 0, 100, 1),
      );
    }
    if (layer.kind === 'ring' || layer.kind === 'blur') {
      controls.push(this.slider(layer, 'size', layer.kind === 'ring' ? 'Width' : 'Radius', 0, 60, 1));
    }

    return el('div', { class: 'layer-panel__controls' }, controls);
  }

  private colour(layer: Layer, field: 'colour' | 'colourTwo', label: string): HTMLElement {
    const input = el('input', {
      class: 'layer-panel__colour',
      type: 'text',
      value: layer[field] ?? '',
      'data-layer-field': field,
      'aria-label': label + ' of ' + layer.name,
      ...(layer.locked ? { disabled: true } : {}),
    }) as HTMLInputElement;
    input.addEventListener('change', () => {
      this.attempt(
        updateLayer(this.book, this.options.elementId, layer.id, { [field]: input.value }),
      );
    });
    return el('label', { class: 'layer-panel__control' }, [
      el('span', {}, [label]),
      input,
    ]);
  }

  private slider(
    layer: Layer,
    field: 'opacity' | 'angle' | 'offsetX' | 'offsetY' | 'blur' | 'size',
    label: string,
    min: number,
    max: number,
    step: number,
  ): HTMLElement {
    const input = el('input', {
      class: 'layer-panel__number',
      type: 'number',
      min,
      max,
      step,
      value: String(layer[field] ?? 0),
      'data-layer-field': field,
      'aria-label': label + ' of ' + layer.name,
      ...(layer.locked ? { disabled: true } : {}),
    }) as HTMLInputElement;
    input.addEventListener('change', () => {
      this.attempt(
        updateLayer(this.book, this.options.elementId, layer.id, {
          [field]: Number(input.value),
        }),
      );
    });
    return el('label', { class: 'layer-panel__control' }, [el('span', {}, [label]), input]);
  }

  private blend(layer: Layer): HTMLElement {
    const select = el('select', {
      class: 'layer-panel__blend',
      'data-layer-field': 'blend',
      'aria-label': 'Blend mode of ' + layer.name,
      ...(layer.locked ? { disabled: true } : {}),
    }) as HTMLSelectElement;

    for (const mode of BLEND_MODES) {
      const option = el('option', { value: mode }, [mode]) as HTMLOptionElement;
      if (mode === layer.blend) option.selected = true;
      select.append(option);
    }
    select.addEventListener('change', () => {
      this.attempt(
        updateLayer(this.book, this.options.elementId, layer.id, {
          blend: select.value as BlendMode,
        }),
      );
    });

    return el('label', { class: 'layer-panel__control' }, [el('span', {}, ['Blend']), select]);
  }
}
