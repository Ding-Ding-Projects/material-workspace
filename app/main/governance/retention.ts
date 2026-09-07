/**
 * Retention: how long a thing is kept, and what happens at the end.
 *
 * The rule that matters is that A RETENTION POLICY NEVER DELETES ANYTHING BY
 * ITSELF. It marks what is due, and a person acts. Automatic deletion driven
 * by a date is how organisations destroy the one document they later needed,
 * and it is unrecoverable by definition.
 *
 * Two more that follow:
 *
 *   - A LEGAL HOLD OUTRANKS EVERY POLICY. If a document is under hold it is
 *     never due, no matter how old, and the hold is reported as the reason so
 *     nobody spends an afternoon wondering why the policy is not working.
 *   - THE CLOCK STARTS AT AN EVENT, not at creation. "Seven years after the
 *     contract ends" and "seven years after the file was made" are different
 *     dates, and using the wrong one is how records are destroyed early.
 */

export type RetentionTrigger = 'created' | 'modified' | 'closed' | 'custom';

export interface RetentionPolicy {
  readonly id: string;
  readonly name: string;
  /** What starts the clock. */
  readonly trigger: RetentionTrigger;
  /** Whole months, because retention is written in months and years. */
  readonly months: number;
  /** What a person should do when it becomes due. */
  readonly action: 'review' | 'archive' | 'delete';
  readonly reason: string;
}

export interface HeldRecord {
  readonly id: string;
  readonly policyId: string;
  /** ISO 8601 dates, UTC. */
  readonly created: string;
  readonly modified: string;
  readonly closed?: string;
  readonly customStart?: string;
  /** A legal hold, with who placed it and why. Outranks every policy. */
  readonly hold?: { readonly by: string; readonly at: string; readonly reason: string };
}

export type DueState = 'held' | 'notDue' | 'due' | 'overdue' | 'noStart';

export interface Assessment {
  readonly record: HeldRecord;
  readonly policy: RetentionPolicy | undefined;
  readonly state: DueState;
  /** The date the clock started, when it could be determined. */
  readonly startedAt?: string;
  readonly dueAt?: string;
  /** Plain words, always. A state code alone tells nobody what to do. */
  readonly explanation: string;
}

/**
 * Add whole months to a date, clamping the day.
 *
 * 31 January plus one month is 28 February, not 3 March. JavaScript's own
 * date arithmetic rolls over, so "one month after the thirty-first" lands in
 * the month after next — which for a retention date means destroying a record
 * a month early or keeping it a month late, every time.
 */
export function addMonths(iso: string, months: number): string {
  const date = new Date(iso + (iso.length === 10 ? 'T00:00:00Z' : ''));
  if (Number.isNaN(date.getTime())) throw new RangeError('not a date: ' + iso);

  const day = date.getUTCDate();
  const target = new Date(date.getTime());
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);

  // The last day of the target month, so the day can be clamped rather than
  // rolled into the next one.
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));

  return target.toISOString().slice(0, 10);
}

function startFor(record: HeldRecord, policy: RetentionPolicy): string | undefined {
  switch (policy.trigger) {
    case 'created':
      return record.created;
    case 'modified':
      return record.modified;
    case 'closed':
      return record.closed;
    default:
      return record.customStart;
  }
}

/**
 * Assess one record.
 *
 * Never deletes, never mutates. It answers a question and explains its answer.
 */
export function assess(
  record: HeldRecord,
  policies: readonly RetentionPolicy[],
  today: string,
): Assessment {
  const policy = policies.find((candidate) => candidate.id === record.policyId);

  if (record.hold !== undefined) {
    // Checked FIRST, before anything else, so a held record is never reported
    // as due even for a moment.
    return {
      record,
      policy,
      state: 'held',
      explanation:
        'Under legal hold since ' +
        record.hold.at.slice(0, 10) +
        ', placed by ' +
        record.hold.by +
        ': ' +
        record.hold.reason +
        '. A hold outranks every retention policy.',
    };
  }

  if (policy === undefined) {
    return {
      record,
      policy: undefined,
      state: 'noStart',
      explanation:
        'No policy named ' +
        record.policyId +
        ' exists, so nothing can be worked out about this record. It is kept.',
    };
  }

  const startedAt = startFor(record, policy);
  if (startedAt === undefined) {
    // A record whose clock has not started is NOT due. Treating a missing
    // start date as "now" would make an open contract immediately expired.
    return {
      record,
      policy,
      state: 'noStart',
      explanation:
        'The clock starts when this record is ' +
        policy.trigger +
        ', which has not happened yet. It is kept until then.',
    };
  }

  const dueAt = addMonths(startedAt, policy.months);
  const overdueAt = addMonths(dueAt, 3);

  if (today < dueAt) {
    return {
      record,
      policy,
      startedAt,
      dueAt,
      state: 'notDue',
      explanation:
        'Kept until ' + dueAt + ', which is ' + policy.months + ' months after ' + startedAt + '.',
    };
  }

  const state: DueState = today >= overdueAt ? 'overdue' : 'due';
  return {
    record,
    policy,
    startedAt,
    dueAt,
    state,
    explanation:
      (state === 'overdue' ? 'Overdue since ' : 'Due since ') +
      dueAt +
      '. The policy says: ' +
      policy.action +
      '. ' +
      policy.reason +
      ' Nothing has been done automatically.',
  };
}

export interface RetentionSummary {
  readonly total: number;
  readonly held: number;
  readonly due: number;
  readonly overdue: number;
  readonly notDue: number;
  readonly unknown: number;
}

export function summarise(assessments: readonly Assessment[]): RetentionSummary {
  const count = (state: DueState): number =>
    assessments.filter((assessment) => assessment.state === state).length;

  return {
    total: assessments.length,
    held: count('held'),
    due: count('due'),
    overdue: count('overdue'),
    notDue: count('notDue'),
    unknown: count('noStart'),
  };
}

/**
 * The records a person should act on, most urgent first.
 *
 * Held records are excluded entirely rather than sorted to the bottom: they
 * are not actionable, and putting them in a list of things to do is how
 * somebody deletes one.
 */
export function actionable(assessments: readonly Assessment[]): Assessment[] {
  const order: Record<DueState, number> = {
    overdue: 0,
    due: 1,
    notDue: 2,
    noStart: 3,
    held: 4,
  };
  return assessments
    .filter((assessment) => assessment.state === 'due' || assessment.state === 'overdue')
    .sort((a, b) => order[a.state] - order[b.state] || (a.dueAt ?? '').localeCompare(b.dueAt ?? ''));
}
