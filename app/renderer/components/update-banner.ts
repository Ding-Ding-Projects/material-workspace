/**
 * The update banner.
 *
 * Persistent and NON-BLOCKING, like GitHub Desktop's. It sits at the edge of
 * the window saying what is available; it never takes focus, never covers what
 * somebody is doing, and never restarts anything on its own.
 *
 * The restart is the user's press, always. An application that restarts itself
 * to install something is an application that has decided its own convenience
 * outranks whatever the person had open.
 */

import { clear, el } from '../dom.js';
import {
  type State,
  describe as describeUpdate,
  initial,
} from '../../shared/updates.js';

export interface UpdateBannerOptions {
  readonly current: string;
  readonly onCheck?: () => void;
  readonly onDownload?: () => void;
  readonly onRestart?: () => void;
  readonly onOpenNotes?: (url: string) => void;
  /** Asked before restarting. Returning false means something is unsaved. */
  readonly canRestart?: () => boolean;
}

export class UpdateBanner {
  readonly element: HTMLElement;

  private state: State;
  private dismissed = false;

  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly actions: HTMLElement;

  constructor(private readonly options: UpdateBannerOptions) {
    this.state = initial(options.current);

    this.title = el('p', { class: 'update-title' });
    this.body = el('p', { class: 'update-body' });
    this.actions = el('div', { class: 'update-actions' });

    this.element = el(
      'aside',
      {
        class: 'update-banner',
        // A status region, NOT an alert. An alert interrupts a screen reader
        // mid-sentence, and an available update is not worth interrupting
        // anybody for.
        role: 'status',
        'aria-live': 'polite',
        hidden: true,
      },
      [el('div', { class: 'update-text' }, [this.title, this.body]), this.actions],
    );

    this.render();
  }

  /** The state, for tests and for the shell. */
  current(): State {
    return this.state;
  }

  set(state: State): void {
    // A NEW stage un-dismisses. Somebody who dismissed "checking" has not
    // dismissed "ready", and treating one press as consent for every later
    // state is how an update sits unnoticed for a month.
    if (state.stage !== this.state.stage) this.dismissed = false;
    this.state = state;
    this.render();
  }

  private render(): void {
    const words = describeUpdate(this.state);

    // Hidden when there is nothing worth saying AND nobody asked. `idle` and
    // `none` are not news; every other stage is.
    const quiet = this.state.stage === 'idle' || this.state.stage === 'none';
    this.element.hidden = this.dismissed || quiet;
    this.element.dataset['stage'] = this.state.stage;

    this.title.textContent = words.title;
    this.body.textContent = words.body;

    clear(this.actions);

    if (this.state.stage === 'available') {
      const download = el('button', {
        class: 'update-action update-action--primary',
        type: 'button',
        text: 'Download it',
      }) as HTMLButtonElement;
      download.addEventListener('click', () => this.options.onDownload?.());
      this.actions.append(download);
    }

    if (words.canRestart) {
      const restart = el('button', {
        class: 'update-action update-action--primary',
        type: 'button',
        text: 'Restart to install update',
      }) as HTMLButtonElement;
      restart.addEventListener('click', () => {
        // Unsaved work is checked BEFORE restarting, not after. There is no
        // after: the process is gone.
        if (this.options.canRestart?.() === false) {
          this.body.textContent =
            'Something is unsaved. Save or discard it first — the restart would take it with it.';
          return;
        }
        this.options.onRestart?.();
      });
      this.actions.append(restart);
    }

    const notes = this.state.release?.notesUrl ?? '';
    if (notes !== '') {
      const link = el('button', {
        class: 'update-action',
        type: 'button',
        text: 'What changed',
      }) as HTMLButtonElement;
      link.addEventListener('click', () => this.options.onOpenNotes?.(notes));
      this.actions.append(link);
    }

    if (this.state.stage === 'offline' || this.state.stage === 'failed') {
      const again = el('button', {
        class: 'update-action',
        type: 'button',
        text: 'Try again',
      }) as HTMLButtonElement;
      again.addEventListener('click', () => this.options.onCheck?.());
      this.actions.append(again);
    }

    // "Later" is always available, on every stage that shows. A banner that
    // cannot be dismissed is a modal wearing a different shape.
    const later = el('button', {
      class: 'update-action',
      type: 'button',
      text: 'Later',
      'aria-label': 'Dismiss this until the update state changes',
    }) as HTMLButtonElement;
    later.addEventListener('click', () => {
      this.dismissed = true;
      this.render();
    });
    this.actions.append(later);
  }
}
