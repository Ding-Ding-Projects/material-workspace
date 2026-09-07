/**
 * Governance.
 *
 * Classification, sensitive-content scanning, and retention, in one surface,
 * because they are the three questions somebody asks about a document at the
 * same moment: how sensitive is it, does it contain anything it should not,
 * and how long do we keep it.
 *
 * Every one of them REPORTS rather than acts. Nothing here deletes, blocks
 * silently, or changes a label on its own. That is not timidity: an automatic
 * governance action is unrecoverable by definition, and a system people route
 * around because it acted on its own is worse than no system.
 *
 * The scanner runs in the renderer on text the user supplies. It makes no
 * network request and writes nothing anywhere — the matched text never leaves
 * this function, and only a redacted preview is ever displayed.
 */

import { clear, el } from '../dom.js';
import {
  type Label,
  type Sensitivity,
  decideExport,
  decideLabelChange,
  describeSensitivity,
  highest,
  inheritLabel,
} from '../../main/governance/classification.js';
import {
  type Finding,
  scan,
  summarise as summariseFindings,
} from '../../main/governance/dlp.js';
import {
  type Assessment,
  type HeldRecord,
  type RetentionPolicy,
  actionable,
  assess,
  summarise as summariseRetention,
} from '../../main/governance/retention.js';

export interface GovernanceOptions {
  now?: () => Date;
}

const SENSITIVITIES: readonly Sensitivity[] = [
  'unknown',
  'public',
  'internal',
  'confidential',
  'restricted',
];

const DESTINATIONS: readonly {
  id: string;
  description: string;
  maximum: Sensitivity;
  external: boolean;
}[] = [
  { id: 'public-site', description: 'A public website', maximum: 'public', external: true },
  { id: 'supplier', description: 'A supplier', maximum: 'confidential', external: true },
  { id: 'internal', description: 'An internal share', maximum: 'internal', external: false },
  { id: 'secure', description: 'The secure vault', maximum: 'restricted', external: false },
];

const POLICIES: readonly RetentionPolicy[] = [
  {
    id: 'contracts',
    name: 'Contracts',
    trigger: 'closed',
    months: 84,
    action: 'review',
    reason: 'Statutory minimum for commercial contracts.',
  },
  {
    id: 'correspondence',
    name: 'Correspondence',
    trigger: 'modified',
    months: 24,
    action: 'archive',
    reason: 'Kept for two years after the last exchange.',
  },
  {
    id: 'drafts',
    name: 'Working drafts',
    trigger: 'created',
    months: 6,
    action: 'delete',
    reason: 'Drafts are superseded by the final version.',
  },
];

const RECORDS: readonly HeldRecord[] = [
  { id: 'CON-2018-04', policyId: 'contracts', created: '2018-01-10', modified: '2018-03-02', closed: '2018-03-02' },
  { id: 'CON-2024-11', policyId: 'contracts', created: '2024-09-01', modified: '2024-11-20' },
  {
    id: 'CON-2011-02',
    policyId: 'contracts',
    created: '2011-02-01',
    modified: '2011-06-01',
    closed: '2011-06-01',
    hold: { by: 'Legal', at: '2025-11-03', reason: 'Pending litigation.' },
  },
  { id: 'MAIL-2022-77', policyId: 'correspondence', created: '2022-02-01', modified: '2022-08-14' },
  { id: 'DRAFT-2026-03', policyId: 'drafts', created: '2026-01-05', modified: '2026-01-09' },
];

export class Governance {
  readonly element: HTMLElement;

  private label: Label | undefined;
  private mayLower = false;
  private text = '';
  private findings: Finding[] = [];
  private note = '';

  private readonly now: () => Date;

  private readonly labelPanel: HTMLElement;
  private readonly exportPanel: HTMLElement;
  private readonly scanInput: HTMLTextAreaElement;
  private readonly scanPanel: HTMLElement;
  private readonly retentionPanel: HTMLElement;
  private readonly statusLine: HTMLElement;

  constructor(options: GovernanceOptions = {}) {
    this.now = options.now ?? (() => new Date());

    this.labelPanel = el('div', { class: 'governance__panel' });
    this.exportPanel = el('div', { class: 'governance__panel' });
    this.scanPanel = el('div', { class: 'governance__panel' });
    this.retentionPanel = el('div', { class: 'governance__panel' });
    this.statusLine = el('div', {
      class: 'governance__status',
      role: 'status',
      'aria-live': 'polite',
    });

    this.scanInput = el('textarea', {
      class: 'governance__scan-input',
      rows: '5',
      'aria-label': 'Text to scan for sensitive content',
      placeholder:
        'Paste text to check. It is scanned here, on this machine, and nothing is sent or stored.',
      spellcheck: 'false',
    }) as HTMLTextAreaElement;

    this.element = el('div', { class: 'governance' }, [
      el('div', { class: 'governance__body' }, [
        el('section', { class: 'governance__section', 'aria-label': 'Classification' }, [
          el('h2', { class: 'governance__heading' }, ['Classification']),
          this.labelPanel,
          el('h3', { class: 'governance__sub-heading' }, ['Where it may go']),
          this.exportPanel,
        ]),
        el('section', { class: 'governance__section', 'aria-label': 'Sensitive content' }, [
          el('h2', { class: 'governance__heading' }, ['Sensitive content']),
          el('p', { class: 'governance__caveat' }, [
            'This finds patterns, not secrets. It cannot tell a real card number from a test one, ' +
              'or a private key from a paragraph about private keys. It is a prompt to look, not a verdict.',
          ]),
          this.scanInput,
          this.scanPanel,
        ]),
        el('section', { class: 'governance__section', 'aria-label': 'Retention' }, [
          el('h2', { class: 'governance__heading' }, ['Retention']),
          el('p', { class: 'governance__caveat' }, [
            'Nothing here deletes anything. A policy marks what is due; a person acts. ' +
              'Automatic deletion driven by a date is how the one document somebody later needed gets destroyed.',
          ]),
          this.retentionPanel,
        ]),
      ]),
      this.statusLine,
    ]);

    this.wire();
    this.render();
  }

  private wire(): void {
    this.labelPanel.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('[data-set-label]');
      if (target !== null) {
        this.applyLabel(target.getAttribute('data-set-label') as Sensitivity);
        return;
      }
      const inherit = (event.target as HTMLElement).closest('[data-inherit]');
      if (inherit !== null) this.applyInherited();
    });

    this.labelPanel.addEventListener('change', (event) => {
      const target = event.target as HTMLInputElement;
      if (target.getAttribute('data-may-lower') === null) return;
      this.mayLower = target.checked;
      this.render();
    });

    this.scanInput.addEventListener('input', () => {
      this.text = this.scanInput.value;
      this.findings = this.text.trim().length === 0 ? [] : scan(this.text);
      this.renderScan();
      this.renderStatus();
    });
  }

  private applyLabel(target: Sensitivity): void {
    const decision = decideLabelChange({
      from: this.label,
      to: target,
      by: 'you',
      at: this.now().toISOString(),
      mayLower: this.mayLower,
      // A justification would come from a prompt in a real deployment. Here
      // the fixed text is honest about being a placeholder rather than
      // pretending somebody typed a reason.
      justification: this.mayLower
        ? 'Lowered from the governance panel during a demonstration.'
        : undefined,
    });

    if (!decision.allowed) {
      this.note = decision.reason;
      this.render();
      return;
    }

    this.label = decision.label;
    this.note = decision.raised
      ? 'Raised to ' + target + '. Raising never needs authority or a reason.'
      : 'Set to ' + target + '.';
    this.render();
  }

  private applyInherited(): void {
    // Two sources, one of them restricted, so the inheritance rule is visible
    // rather than asserted.
    const sources: Label[] = [
      { sensitivity: 'public', by: 'a colleague', at: this.now().toISOString() },
      { sensitivity: 'restricted', by: 'a colleague', at: this.now().toISOString() },
    ];
    this.label = inheritLabel(sources, 'you', this.now().toISOString());
    this.note =
      'Derived from a public source and a restricted one. It inherits the HIGHEST: ' +
      highest(sources.map((source) => source.sensitivity)) +
      '.';
    this.render();
  }

  // ------------------------------------------------------------- rendering --

  private render(): void {
    this.renderLabel();
    this.renderExport();
    this.renderScan();
    this.renderRetention();
    this.renderStatus();
  }

  private renderLabel(): void {
    clear(this.labelPanel);

    const current = this.label?.sensitivity ?? 'unknown';

    this.labelPanel.append(
      el('div', { class: 'governance__current', 'data-sensitivity': current }, [
        el('span', { class: 'governance__current-label' }, [current]),
        el('span', { class: 'governance__current-meaning' }, [describeSensitivity(current)]),
      ]),
    );

    const buttons = el('div', { class: 'governance__row' });
    for (const sensitivity of SENSITIVITIES) {
      if (sensitivity === 'unknown') continue;
      buttons.append(
        el(
          'button',
          {
            class: 'governance__action',
            type: 'button',
            'data-set-label': sensitivity,
            'aria-pressed': current === sensitivity ? 'true' : 'false',
          },
          [sensitivity],
        ),
      );
    }
    buttons.append(
      el(
        'button',
        {
          class: 'governance__action',
          type: 'button',
          'data-inherit': 'true',
          title: 'Derive this document from a public source and a restricted one',
        },
        ['Derive from two sources'],
      ),
    );
    this.labelPanel.append(buttons);

    this.labelPanel.append(
      el('label', { class: 'governance__inline', for: 'governance-may-lower' }, [
        el('input', {
          class: 'governance__checkbox',
          type: 'checkbox',
          id: 'governance-may-lower',
          'data-may-lower': 'true',
          ...(this.mayLower ? { checked: 'checked' } : {}),
        }),
        el('span', {}, ['I hold the authority to LOWER a label']),
      ]),
      el('p', { class: 'governance__note' }, [
        'Raising a label is always allowed and needs no reason: erring towards more protection is ' +
          'never the dangerous direction. Lowering needs both authority and a written justification, ' +
          'and the justification is recorded.',
      ]),
    );

    if (this.label?.justification !== undefined) {
      this.labelPanel.append(
        el('p', { class: 'governance__justification' }, [
          'Recorded justification: ' + this.label.justification,
        ]),
      );
    }
    if (this.label?.derivedFrom !== undefined) {
      this.labelPanel.append(
        el('p', { class: 'governance__note' }, [
          'Inherited from: ' + this.label.derivedFrom.join(', ') + '.',
        ]),
      );
    }
  }

  private renderExport(): void {
    clear(this.exportPanel);

    for (const destination of DESTINATIONS) {
      const decision = decideExport(this.label, destination);
      const row = el(
        'div',
        {
          class: 'governance__destination',
          'data-destination': destination.id,
          // The verdict is an attribute as well as a colour, so a screen
          // reader and a check can both read it.
          'data-allowed': decision.allowed ? 'true' : 'false',
        },
        [
          el('span', { class: 'governance__destination-name' }, [destination.description]),
          el('span', { class: 'governance__destination-verdict' }, [
            decision.allowed ? 'Allowed' : 'Refused',
          ]),
          el('span', { class: 'governance__destination-why' }, [
            decision.allowed
              ? decision.warnings.length === 0
                ? 'Nothing to flag.'
                : decision.warnings.join(' ')
              : decision.reason,
          ]),
        ],
      );
      this.exportPanel.append(row);
    }
  }

  private renderScan(): void {
    clear(this.scanPanel);

    if (this.text.trim().length === 0) {
      this.scanPanel.append(
        el('p', { class: 'governance__empty' }, ['Nothing to scan yet.']),
      );
      return;
    }

    const summary = summariseFindings(this.findings);
    if (summary.total === 0) {
      this.scanPanel.append(
        el('p', { class: 'governance__empty' }, [
          'Nothing matched. That is not a guarantee: this looks for known patterns only.',
        ]),
      );
      return;
    }

    this.scanPanel.append(
      el('div', { class: 'governance__row' }, [
        el('span', { class: 'governance__summary' }, [
          summary.total + (summary.total === 1 ? ' finding' : ' findings'),
        ]),
        ...summary.byKind.map((entry) =>
          el('span', { class: 'governance__chip' }, [entry.label + ' ' + entry.count]),
        ),
      ]),
    );

    const list = el('ul', { class: 'governance__findings' });
    for (const finding of this.findings) {
      list.append(
        el('li', { class: 'governance__finding', 'data-confidence': finding.confidence }, [
          el('span', { class: 'governance__finding-label' }, [finding.label]),
          // The preview is redacted. The matched text never leaves the scan.
          el('span', { class: 'governance__finding-preview' }, [finding.preview]),
          el('span', { class: 'governance__finding-confidence' }, [
            finding.confidence + ' confidence',
          ]),
          ...(finding.caveat === undefined
            ? []
            : [el('span', { class: 'governance__finding-caveat' }, [finding.caveat])]),
        ]),
      );
    }
    this.scanPanel.append(list);
  }

  private renderRetention(): void {
    clear(this.retentionPanel);

    const today = this.now().toISOString().slice(0, 10);
    const assessments = RECORDS.map((record) => assess(record, POLICIES, today));
    const summary = summariseRetention(assessments);

    this.retentionPanel.append(
      el('div', { class: 'governance__row' }, [
        el('span', { class: 'governance__chip', 'data-state': 'overdue' }, [
          'Overdue ' + summary.overdue,
        ]),
        el('span', { class: 'governance__chip', 'data-state': 'due' }, ['Due ' + summary.due]),
        el('span', { class: 'governance__chip', 'data-state': 'held' }, ['Held ' + summary.held]),
        el('span', { class: 'governance__chip', 'data-state': 'notDue' }, [
          'Not due ' + summary.notDue,
        ]),
        el('span', { class: 'governance__chip', 'data-state': 'noStart' }, [
          'Clock not started ' + summary.unknown,
        ]),
      ]),
    );

    const list = el('div', { class: 'governance__records' });
    for (const assessment of assessments) {
      list.append(this.recordRow(assessment));
    }
    this.retentionPanel.append(list);

    const todo = actionable(assessments);
    this.retentionPanel.append(
      el('p', { class: 'governance__note' }, [
        todo.length === 0
          ? 'Nothing needs a decision today.'
          : todo.length +
            (todo.length === 1 ? ' record needs' : ' records need') +
            ' a decision: ' +
            todo.map((assessment) => assessment.record.id).join(', ') +
            '. Held records are not listed, because they are not actionable.',
      ]),
    );
  }

  private recordRow(assessment: Assessment): HTMLElement {
    return el(
      'div',
      { class: 'governance__record', 'data-state': assessment.state },
      [
        el('span', { class: 'governance__record-id' }, [assessment.record.id]),
        el('span', { class: 'governance__record-policy' }, [
          assessment.policy?.name ?? 'No policy',
        ]),
        // The state is a word, not a colour. A colour alone is invisible to a
        // screen reader and ambiguous to everybody else.
        el('span', { class: 'governance__record-state' }, [stateWord(assessment.state)]),
        el('span', { class: 'governance__record-why' }, [assessment.explanation]),
      ],
    );
  }

  private renderStatus(): void {
    const parts: string[] = [
      'Label: ' + (this.label?.sensitivity ?? 'unknown'),
      this.findings.length + (this.findings.length === 1 ? ' finding' : ' findings'),
    ];
    if (this.note !== '') parts.push(this.note);

    clear(this.statusLine);
    this.statusLine.append(parts.join('   '));
    this.note = '';
  }
}

function stateWord(state: Assessment['state']): string {
  switch (state) {
    case 'held':
      return 'Legal hold';
    case 'due':
      return 'Due';
    case 'overdue':
      return 'Overdue';
    case 'notDue':
      return 'Not due';
    default:
      return 'Clock not started';
  }
}
