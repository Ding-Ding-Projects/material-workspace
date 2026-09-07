/**
 * The attention modes.
 *
 * Five modes, each INDEPENDENTLY toggleable and each off by default. Never one
 * master switch: attention difficulties do not arrive as a single setting, and
 * bundling them means most people turn the whole thing off to escape the one
 * part that does not suit them.
 *
 * They are accommodations, not opinions about how anybody should work. A mode
 * that switches itself on has decided something about the user it has no
 * standing to decide.
 *
 * Tone rules, which matter more here than almost anywhere else. Copy is plain,
 * factual, and free of judgement: it says what is true ("nothing has changed
 * here for 40 minutes") and never what the user should feel about it. No
 * streaks, no scores, no congratulation, no scolding, and nothing that implies
 * anything about a person. None of it is medical, and none of it is named in a
 * way that discloses anything to somebody reading over a shoulder.
 *
 * Every mode here has a real reader. A setting that persists a value and changes
 * nothing is a decorative control, and no capture reveals it.
 */

import { clear, el } from './dom.js';
import type { AdhdModes } from '../shared/settings.js';
import type { Notifications } from './components/notifications.js';

/** How long without a change before Momentum says anything. */
const MOMENTUM_IDLE_MS = 10 * 60 * 1000;
const MOMENTUM_SNOOZE_MS = 30 * 60 * 1000;
const TIME_TICK_MS = 30 * 1000;

export interface AttentionHost {
  /** Where the time-awareness readout and the next-action line are rendered. */
  statusBar: HTMLElement;
  notifications: Notifications;
}

export class AttentionModes {
  private modes: AdhdModes = {
    focus: false,
    lowStimulation: false,
    timeAwareness: false,
    oneThingAtATime: false,
    momentum: false,
  };

  private readonly startedAt = Date.now();
  private lastChangeAt = Date.now();
  private snoozedUntil = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private host: AttentionHost | null = null;

  /** The one visible next action. Chosen by the user, never inferred: a guessed
   *  next step is worse than none, because it is confidently wrong. */
  private nextAction = '';

  attach(host: AttentionHost): void {
    this.host = host;
  }

  /**
   * Apply the modes to the document.
   *
   * Every attribute set here has a rule that consumes it in `attention.css`.
   * They are set as attributes rather than classes so the stylesheet can express
   * combinations without a class for each pairing.
   */
  apply(modes: AdhdModes): void {
    this.modes = modes;
    const html = document.documentElement;
    html.setAttribute('data-focus-mode', modes.focus ? 'on' : 'off');
    html.setAttribute('data-low-stimulation', modes.lowStimulation ? 'on' : 'off');
    html.setAttribute('data-time-awareness', modes.timeAwareness ? 'on' : 'off');
    html.setAttribute('data-one-thing', modes.oneThingAtATime ? 'on' : 'off');

    this.updateTicker();
    this.render();
  }

  /** Called whenever the user actually changes something, so Momentum measures
   *  real inactivity rather than wall-clock time. */
  recordActivity(): void {
    this.lastChangeAt = Date.now();
  }

  /** Low stimulation reduces notifications to the ones that genuinely need a
   *  person. It never suppresses a warning or an error. */
  shouldSuppressNotification(severity: string): boolean {
    if (!this.modes.lowStimulation) return false;
    return severity === 'info' || severity === 'success';
  }

  private updateTicker(): void {
    const wanted = this.modes.timeAwareness || this.modes.momentum;
    if (wanted && !this.ticker) {
      this.ticker = setInterval(() => this.tick(), TIME_TICK_MS);
    } else if (!wanted && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private tick(): void {
    this.render();

    if (!this.modes.momentum) return;
    const now = Date.now();
    if (now < this.snoozedUntil) return;
    if (now - this.lastChangeAt < MOMENTUM_IDLE_MS) return;

    const minutes = Math.round((now - this.lastChangeAt) / 60000);
    this.host?.notifications.push({
      key: 'momentum',
      severity: 'info',
      // States a fact. Never says what to do about it, and never implies
      // anything about the person reading it.
      title: 'Nothing has changed here for ' + minutes + ' minutes.',
      actions: [
        {
          // "Not now" is respected for a stated period, not for thirty seconds.
          label: 'Not for the next 30 minutes',
          run: () => {
            this.snoozedUntil = Date.now() + MOMENTUM_SNOOZE_MS;
          },
        },
      ],
    });
  }

  private elapsedLabel(): string {
    const seconds = Math.floor((Date.now() - this.startedAt) / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return hours + 'h ' + minutes + 'm';
    if (minutes > 0) return minutes + 'm';
    return 'under a minute';
  }

  /** Render the readouts into the status bar, where the work is. */
  render(): void {
    const host = this.host;
    if (!host) return;

    const existing = host.statusBar.querySelector('.attention');
    if (existing) existing.remove();

    if (!this.modes.timeAwareness && !this.modes.oneThingAtATime) return;

    const region = el('div', { class: 'attention' });

    if (this.modes.timeAwareness) {
      // A number, stated. Not a nag, not a target, not a streak.
      region.append(
        el('span', { class: 'attention__time' }, [
          el('span', { class: 'attention__label', text: 'This session' }),
          el('span', { class: 'attention__value', text: this.elapsedLabel() }),
        ]),
      );
    }

    if (this.modes.oneThingAtATime) {
      const field = el('input', {
        class: 'attention__next',
        type: 'text',
        id: 'attention-next-action',
        placeholder: 'The one thing you are doing next',
        'aria-label': 'The one thing you are doing next',
        value: this.nextAction,
      }) as HTMLInputElement;
      field.addEventListener('change', () => {
        // Chosen by the user. It persists across a re-render, which is the
        // whole point: it has to survive a context switch.
        this.nextAction = field.value;
      });
      region.append(field);
    }

    host.statusBar.append(region);
  }

  dispose(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }
}
