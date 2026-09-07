/**
 * Locks, and the way out of them.
 *
 * Three things live here because they are one story: the locks somebody has
 * set, the ladder they meet when they are locked out, and Support Tickets -
 * which is the recovery route, dressed as a service desk.
 *
 * The bit is a bit, and the surface says so outside the comedy. Nothing is
 * sent anywhere, no ticket exists off this machine, and nobody is reading it.
 * A person must never sit waiting for a reply that was never coming.
 */

import {
  POLICIES,
  type LockRecord,
  type Policy,
  factorsOf,
  recoveryAdvice,
} from '../../shared/locks.js';
import {
  DISHES_BEFORE_SUMS,
  SKIP_BUDGET,
  type Rung,
  fallTo,
  lockoutWaitMs,
  skipsRemaining,
  startingRung,
} from '../../shared/ladder.js';
import { clear, el } from '../dom.js';

export interface LocksSurfaceOptions {
  /** Where deleting resets everything. Named, never gestured at. */
  readonly dataFolder: string;
  readonly schoolMode?: boolean;
  /** Injected so a test can assert a folder was opened without opening one. */
  readonly onOpenFolder?: (folder: string) => void;
}

interface Ticket {
  readonly number: string;
  readonly category: string;
  readonly description: string;
  status: 'Open' | 'Triaged' | 'Resolved';
}

const POLICY_LABELS: Record<Policy, string> = {
  pin: 'A PIN',
  password: 'A password',
  'pin+password': 'A PIN, then a password',
  'password+totp': 'A password, then a code from your authenticator',
  'pin+totp': 'A PIN, then a code from your authenticator',
  'password+pin+totp': 'A password, a PIN, then a code from your authenticator',
};

/** What each rung costs to fail. Beside the rung, not in a footnote. */
const NOTES: Record<Rung, string> = {
  dimsum: DISHES_BEFORE_SUMS + ' wrong and it moves on.',
  sums: 'One wrong and it moves on.',
  moles: 'Lose the round and it moves on.',
  clock: 'The ladder is not offered again for this lockout.',
};

const RUNG_LABELS: Record<Rung, string> = {
  dimsum: 'Name the dim sum - one dish, four choices',
  sums: 'Ten easy sums, all of which must be right',
  moles: 'Whack-a-mole, for one round',
  clock: 'The clock. Serve the wait you were already serving.',
};

export class LocksSurface {
  readonly element: HTMLElement;

  private locks: LockRecord[] = [];
  private tickets: Ticket[] = [];
  private ticketCounter = 0;

  private readonly lockList: HTMLElement;
  private readonly ticketList: HTMLElement;
  private readonly targetInput: HTMLInputElement;
  private readonly policySelect: HTMLSelectElement;
  private readonly durationSelect: HTMLSelectElement;
  private readonly ladderList: HTMLElement;

  constructor(private readonly options: LocksSurfaceOptions) {
    this.lockList = el('ul', { class: 'locks-list', role: 'list' });
    this.ticketList = el('ul', { class: 'locks-tickets', role: 'list' });
    this.ladderList = el('ol', { class: 'locks-ladder' });

    this.targetInput = el('input', {
      class: 'locks-input',
      type: 'text',
      id: 'locks-target',
      placeholder: 'For example: the Appearance tab',
    }) as HTMLInputElement;

    this.policySelect = el('select', {
      class: 'locks-select',
      id: 'locks-policy',
    }) as HTMLSelectElement;
    for (const policy of POLICIES) {
      this.policySelect.append(el('option', { value: policy, text: POLICY_LABELS[policy] }));
    }

    this.durationSelect = el('select', {
      class: 'locks-select',
      id: 'locks-duration',
    }) as HTMLSelectElement;
    for (const [value, label] of [
      ['surface', 'Until I leave this surface'],
      ['minutes', 'For fifteen minutes'],
      ['session', 'Until the application closes'],
    ] as const) {
      this.durationSelect.append(el('option', { value, text: label }));
    }

    const add = el('button', {
      class: 'locks-action',
      type: 'button',
      text: 'Lock it',
    }) as HTMLButtonElement;
    add.addEventListener('click', () => this.addLock());

    this.element = el('section', { class: 'locks', 'aria-label': 'Locks' }, [
      el('header', { class: 'locks-header' }, [
        el('h2', { class: 'locks-title', text: 'Locks' }),
        el('p', {
          class: 'locks-lede',
          text:
            'A speed bump you set for yourself, on anything you like. It is for concentration, ' +
            'not security: it is not encryption, it protects nothing from anybody else with ' +
            'this computer, and it is meant to be undoable.',
        }),
      ]),

      el('div', { class: 'locks-form' }, [
        el('h3', { class: 'locks-subtitle', text: 'Lock something' }),
        el('label', { class: 'locks-label', for: 'locks-target', text: 'What to lock' }),
        this.targetInput,
        el('label', { class: 'locks-label', for: 'locks-policy', text: 'What it will ask for' }),
        this.policySelect,
        el('label', { class: 'locks-label', for: 'locks-duration', text: 'How long an unlock lasts' }),
        this.durationSelect,
        el('p', {
          class: 'locks-help',
          text:
            'Every lock has its OWN credential. There is no master one, and unlocking one thing ' +
            'never unlocks another. If you want the same PIN everywhere, set the same PIN - ' +
            'this will not assume it for you.',
        }),
        add,
      ]),

      el('div', { class: 'locks-panel' }, [
        el('h3', { class: 'locks-subtitle', text: 'What is locked' }),
        this.lockList,
      ]),

      el('div', { class: 'locks-panel' }, [
        el('h3', { class: 'locks-subtitle', text: 'If you are locked out' }),
        el('p', {
          class: 'locks-help',
          text:
            'A countdown with nothing to do is the worst part of being locked out, so there is ' +
            'a ladder. Winning it ends the WAIT and nothing else - you still need your ' +
            'password, it gives you no extra tries, and the next wait is just as long.',
        }),
        this.ladderList,
        el('p', {
          class: 'locks-help',
          text:
            'It can be used at most ' + SKIP_BUDGET + ' times an hour. Four choices is one in ' +
            'four and ten small sums are easy for a machine, so without a cap the lock would ' +
            'be cheaper to break than to wait out.',
        }),
      ]),

      this.buildTickets(),
    ]);

    this.render();
  }

  /** The locks, for tests. */
  current(): readonly LockRecord[] {
    return this.locks;
  }

  private addLock(): void {
    const target = this.targetInput.value.trim();
    if (target === '') return;

    const kind = this.durationSelect.value;
    this.locks = [
      ...this.locks.filter((lock) => lock.target !== target),
      {
        target,
        policy: this.policySelect.value as Policy,
        duration:
          kind === 'minutes'
            ? { kind: 'minutes', minutes: 15 }
            : kind === 'session'
              ? { kind: 'session' }
              : { kind: 'surface' },
        lockedOnLaunch: true,
      },
    ];
    this.targetInput.value = '';
    this.render();
  }

  private buildTickets(): HTMLElement {
    const category = el('select', {
      class: 'locks-select',
      id: 'ticket-category',
    }) as HTMLSelectElement;
    for (const option of [
      'I have forgotten the PIN',
      'I have forgotten the password',
      'My authenticator is on a phone I no longer have',
      'Something else',
    ]) {
      category.append(el('option', { value: option, text: option }));
    }

    const description = el('textarea', {
      class: 'locks-textarea',
      id: 'ticket-description',
      rows: 3,
      placeholder: 'Tell us all about it.',
    }) as HTMLTextAreaElement;

    const raise = el('button', {
      class: 'locks-action',
      type: 'button',
      text: 'Raise a ticket',
    }) as HTMLButtonElement;
    raise.addEventListener('click', () => {
      this.ticketCounter += 1;
      this.tickets = [
        {
          // Locally generated. There is no ticket system; this number means
          // nothing to anybody, which is rather the joke.
          number: 'MW-' + String(10_000 + this.ticketCounter),
          category: category.value,
          description: description.value,
          status: 'Open',
        },
        ...this.tickets,
      ];
      description.value = '';
      this.render();
    });

    return el('div', { class: 'locks-panel locks-support' }, [
      el('h3', { class: 'locks-subtitle', text: 'Support Tickets' }),

      // OUTSIDE THE COMEDY, unstyled by any funny level. Somebody must never
      // sit waiting for a reply that was never coming.
      el('p', {
        class: 'locks-disclosure',
        text:
          'Nothing here is sent anywhere. No ticket exists outside this computer, no request ' +
          'goes over the network, nothing is collected, and nobody is reading it. This is the ' +
          'reset button wearing a lanyard.',
      }),

      el('label', { class: 'locks-label', for: 'ticket-category', text: 'Category' }),
      category,
      el('label', { class: 'locks-label', for: 'ticket-description', text: 'Description' }),
      description,
      raise,
      this.ticketList,
    ]);
  }

  private render(): void {
    // ---- locks ----
    clear(this.lockList);
    if (this.locks.length === 0) {
      this.lockList.append(
        el('li', {
          class: 'locks-empty',
          role: 'listitem',
          text: 'Nothing is locked. Anything you lock will be listed here, individually.',
        }),
      );
    } else {
      for (const lock of this.locks) {
        const remove = el('button', {
          class: 'locks-remove',
          type: 'button',
          text: 'Remove',
          'aria-label': 'Remove the lock on ' + lock.target,
        }) as HTMLButtonElement;
        remove.addEventListener('click', () => {
          this.locks = this.locks.filter((entry) => entry.target !== lock.target);
          this.render();
        });

        this.lockList.append(
          el('li', { class: 'locks-item', role: 'listitem' }, [
            el('span', { class: 'locks-item-target', text: lock.target }),
            el('span', {
              class: 'locks-item-policy',
              text: factorsOf(lock.policy).join(' then '),
            }),
            el('span', {
              class: 'locks-item-duration',
              text:
                lock.duration.kind === 'minutes'
                  ? lock.duration.minutes + ' minutes'
                  : lock.duration.kind === 'session'
                    ? 'until close'
                    : 'this surface only',
            }),
            remove,
          ]),
        );
      }
    }

    // ---- the ladder ----
    clear(this.ladderList);
    let rung: Rung | null = startingRung(this.options.schoolMode === true);
    while (rung !== null) {
      const current: Rung = rung;
      this.ladderList.append(
        el('li', { class: 'locks-rung', 'data-rung': current }, [
          el('span', { class: 'locks-rung-label', text: RUNG_LABELS[current] }),
          el('span', { class: 'locks-rung-note', text: NOTES[current] }),
        ]),
      );
      rung = fallTo(current);
    }

    // The waits, stated rather than discovered. Somebody deciding whether to
    // play the ladder deserves to know what they are playing INSTEAD of, and
    // that the escalation underneath is untouched by winning.
    this.ladderList.append(
      el('li', { class: 'locks-rung locks-rung-waits' }, [
        el('span', {
          class: 'locks-rung-label',
          text:
            'The waits themselves: ' +
            [1, 2, 3, 4].map((n) => Math.round(lockoutWaitMs(n) / 1000) + 's').join(', ') +
            ', up to ' + Math.round(lockoutWaitMs(99) / 60_000) + ' minutes.',
        }),
        el('span', {
          class: 'locks-rung-note',
          text:
            'Winning the ladder does not shorten the next one. ' +
            skipsRemaining({ grantedAt: [] }, 0) + ' skips are available in a fresh hour.',
        }),
      ]),
    );

    // ---- tickets ----
    clear(this.ticketList);
    if (this.tickets.length === 0) {
      this.ticketList.append(
        el('li', {
          class: 'locks-empty',
          role: 'listitem',
          text: 'No tickets yet.',
        }),
      );
    } else {
      for (const ticket of this.tickets) {
        const open = el('button', {
          class: 'locks-action',
          type: 'button',
          text: 'Resolve it myself',
        }) as HTMLButtonElement;
        open.addEventListener('click', () => {
          ticket.status = 'Resolved';
          // The resolution does the only thing that actually works: opens the
          // folder so the person can delete it themselves. Nothing is deleted
          // FOR them - that would be a destructive action, and it would go
          // through the two-key gate rather than behind a joke button.
          this.options.onOpenFolder?.(this.options.dataFolder);
          this.render();
        });

        this.ticketList.append(
          el('li', { class: 'locks-ticket', role: 'listitem' }, [
            el('span', { class: 'locks-ticket-number', text: ticket.number }),
            el('span', { class: 'locks-ticket-status', text: ticket.status }),
            el('span', { class: 'locks-ticket-category', text: ticket.category }),
            el('p', {
              class: 'locks-ticket-reply',
              text:
                ticket.status === 'Resolved'
                  ? 'Resolution: delete the folder below. That is the whole procedure.'
                  : 'Thank you for contacting support. Your ticket is important to us and has ' +
                    'been placed in a queue of length one, behind nobody, attended by no one.',
            }),
            el('p', { class: 'locks-ticket-path', text: this.options.dataFolder }),
            open,
          ]),
        );
      }
    }
  }
}

/** The recovery sentence, exported so the surface and the docs cannot drift. */
export function recoveryLine(dataFolder: string): string {
  return recoveryAdvice(dataFolder);
}
