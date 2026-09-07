/**
 * The destructive-action gate.
 *
 * Two independently operated keys, then a full-range slider. Deliberately
 * awkward, because everything it guards is irreversible.
 *
 * What it must never do, whatever the funny level:
 *
 *   - Obscure WHAT will be destroyed. The playful copy wraps the facts; the
 *     facts themselves — which documents, how many, whether it can be undone —
 *     are stated in unambiguous words at every level.
 *   - Complete without both keys AND a full slider. A gate that can be rushed is
 *     decoration.
 *   - Trap the keyboard. Escape cancels, an Emergency exit is always available,
 *     and focus returns to the control that opened it.
 *
 * This is a modal, and that is correct: it is a decision that must be made
 * before anything continues. Everything that merely informs is a toast.
 */

import { el } from '../dom.js';

export interface SuperConfirmRequest {
  /** What is about to happen, in plain words. Never softened by tone. */
  title: string;
  /** Exactly what will be affected. Named, counted, or both. */
  affected: string;
  /** What cannot be undone afterwards. */
  irreversible: string;
  /** The label on the final action. */
  actionLabel: string;
  /** Returns focus here when the gate closes. */
  anchor: HTMLElement | null;
}

export interface SuperConfirmOutcome {
  confirmed: boolean;
  /** Why it ended, so a caller can distinguish a cancel from an escape. */
  reason: 'confirmed' | 'cancelled' | 'escaped' | 'emergency-exit';
}

const SLIDER_MAX = 100;

export class SuperConfirm {
  /**
   * Open the gate. Resolves only when the user has finished with it — there is
   * no timeout and no auto-dismiss, because a destructive decision must not be
   * made by inactivity.
   */
  static open(request: SuperConfirmRequest): Promise<SuperConfirmOutcome> {
    return new Promise((resolve) => {
      const previousFocus = (document.activeElement as HTMLElement | null) ?? request.anchor;

      let keyOne = false;
      let keyTwo = false;
      let settled = false;

      const finish = (outcome: SuperConfirmOutcome): void => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKeyDown, true);
        scrim.remove();
        (request.anchor ?? previousFocus)?.focus();
        resolve(outcome);
      };

      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish({ confirmed: false, reason: 'escaped' });
        }
      };

      /* ---------------------------------------------------------- structure */

      const slider = el('input', {
        class: 'gate__slider',
        type: 'range',
        min: '0',
        max: String(SLIDER_MAX),
        value: '0',
        step: '1',
        id: 'gate-slider',
        disabled: true,
        'aria-describedby': 'gate-slider-help',
      }) as HTMLInputElement;

      const progress = el('div', { class: 'gate__progress' }, [
        el('div', { class: 'gate__progress-fill' }),
      ]);
      const progressFill = progress.firstElementChild as HTMLElement;

      const sliderHelp = el('p', {
        class: 'gate__help',
        id: 'gate-slider-help',
        text: 'Both keys must be turned before this slider can move. Drag it all the way, or focus it and hold the End key.',
      });

      const action = el('button', {
        class: 'gate__action',
        type: 'button',
        disabled: true,
      }) as HTMLButtonElement;
      action.textContent = request.actionLabel;

      const updateGate = (): void => {
        const bothKeys = keyOne && keyTwo;
        slider.disabled = !bothKeys;
        if (!bothKeys) {
          slider.value = '0';
          progressFill.style.inlineSize = '0%';
          action.disabled = true;
          panel.setAttribute('data-stage', 'keys');
          return;
        }
        const value = Number(slider.value);
        progressFill.style.inlineSize = value + '%';
        const complete = value >= SLIDER_MAX;
        action.disabled = !complete;
        panel.setAttribute('data-stage', complete ? 'ready' : 'sliding');
      };

      const makeKey = (index: 1 | 2): HTMLElement => {
        const id = 'gate-key-' + index;
        const input = el('input', { type: 'checkbox', id }) as HTMLInputElement;
        input.addEventListener('change', () => {
          if (index === 1) keyOne = input.checked;
          else keyTwo = input.checked;
          updateGate();
        });
        return el('label', { class: 'gate__key', for: id }, [
          input,
          el('span', { class: 'gate__key-label', text: 'Key ' + index }),
        ]);
      };

      slider.addEventListener('input', updateGate);

      action.addEventListener('click', () => {
        if (action.disabled) return;
        finish({ confirmed: true, reason: 'confirmed' });
      });

      const cancel = el('button', { class: 'gate__cancel', type: 'button' });
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => finish({ confirmed: false, reason: 'cancelled' }));

      // Always available, at every stage, however far the slider has gone.
      const emergency = el('button', {
        class: 'gate__emergency',
        type: 'button',
        'aria-label': 'Emergency exit: stop immediately and change nothing',
      });
      emergency.textContent = 'Emergency exit';
      emergency.addEventListener('click', () =>
        finish({ confirmed: false, reason: 'emergency-exit' }),
      );

      const panel = el(
        'div',
        {
          class: 'gate',
          role: 'alertdialog',
          'aria-modal': 'true',
          'aria-labelledby': 'gate-title',
          'aria-describedby': 'gate-facts',
          'data-stage': 'keys',
          tabindex: '-1',
        },
        [
          el('h2', { class: 'gate__title', id: 'gate-title', text: request.title }),
          // The facts. Never restyled by tone, never abbreviated, never behind
          // a disclosure — this is the whole reason the gate exists.
          el('div', { class: 'gate__facts', id: 'gate-facts' }, [
            el('p', { class: 'gate__affected', text: request.affected }),
            el('p', { class: 'gate__irreversible', text: request.irreversible }),
          ]),
          el('div', { class: 'gate__keys', role: 'group', 'aria-label': 'Both keys' }, [
            makeKey(1),
            makeKey(2),
          ]),
          el('div', { class: 'gate__slide' }, [slider, progress, sliderHelp]),
          el('div', { class: 'gate__actions' }, [emergency, cancel, action]),
        ],
      );

      const scrim = el('div', { class: 'gate__scrim' }, [panel]);
      document.body.append(scrim);
      document.addEventListener('keydown', onKeyDown, true);

      updateGate();
      // Focus lands on the first key, not on the destructive action.
      scrim.querySelector<HTMLElement>('#gate-key-1')?.focus();
    });
  }
}
