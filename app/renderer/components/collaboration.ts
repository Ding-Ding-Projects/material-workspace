/**
 * Collaboration.
 *
 * A shared document, who else is in it, and — the part that matters most — an
 * honest account of whether anything is actually reaching them.
 *
 * The surface is built around the state that is normally hidden. Most
 * collaborative editors show a row of avatars when things are working and
 * nothing at all when they are not, so the moment somebody most needs to know
 * their edits are stuck is exactly the moment the interface goes quiet. Here
 * the connection state, the queue depth and the last refusal are permanent
 * fixtures, not an error banner that appears once and fades.
 *
 * Nothing on this surface can lose work. Typing is always accepted, because
 * the local document is the truth and the connection is only how it is shared.
 */

import {
  Connection,
  type ConnectionEvents,
  type ConnectionState,
  type Peer,
} from '../../sync/connection.js';
import { clear, el } from '../dom.js';

export interface CollaborationOptions {
  /**
   * Build the connection. Injected so this surface can be driven in a built
   * artifact with no server present, which is the state most people will
   * first meet it in.
   *
   * The events are passed IN rather than attached afterwards. Reaching into a
   * constructed object to wire its callbacks works until the object decides to
   * read them once at construction, at which point the surface silently stops
   * updating and nothing anywhere says why.
   */
  readonly connect?: (url: string, events: ConnectionEvents) => Connection;
  readonly onChange?: () => void;
}

interface StateStyle {
  readonly emoji: string;
  readonly label: { en: string; yue: string };
  readonly tone: 'live' | 'working' | 'idle' | 'bad';
}

/**
 * Every state carries a word AND an emoji, never a colour alone.
 *
 * A dot that is green or amber tells a colour-blind reader nothing, and tells
 * a screen-reader user nothing at all.
 */
const STATES: Record<ConnectionState, StateStyle> = {
  offline: { emoji: '\u{1F4F4}', label: { en: 'Working offline', yue: '離線工作' }, tone: 'idle' },
  connecting: { emoji: '\u{1F50C}', label: { en: 'Connecting', yue: '連線中' }, tone: 'working' },
  joining: { emoji: '\u{1F6AA}', label: { en: 'Joining', yue: '加入緊' }, tone: 'working' },
  live: { emoji: '\u{1F7E2}', label: { en: 'Connected', yue: '已連線' }, tone: 'live' },
  reconnecting: {
    emoji: '\u{1F504}',
    label: { en: 'Reconnecting', yue: '重新連線' },
    tone: 'working',
  },
  refused: { emoji: '\u{26D4}', label: { en: 'Refused', yue: '被拒絕' }, tone: 'bad' },
};

export class Collaboration {
  readonly element: HTMLElement;

  private connection: Connection | null = null;
  private state: ConnectionState = 'offline';
  private detail = '';
  private peers: readonly Peer[] = [];
  private refusal: { reason: string; fatal: boolean } | null = null;

  private readonly statusRow: HTMLElement;
  private readonly peerList: HTMLElement;
  private readonly queueRow: HTMLElement;
  private readonly refusalRow: HTMLElement;
  private readonly editor: HTMLTextAreaElement;
  private readonly serverField: HTMLInputElement;
  private readonly roomField: HTMLInputElement;
  private readonly nameField: HTMLInputElement;
  private readonly connectButton: HTMLButtonElement;

  /** Suppresses the echo when a remote change rewrites the editor's value. */
  private applying = false;

  constructor(private readonly options: CollaborationOptions = {}) {
    this.statusRow = el('div', { class: 'collab-status', role: 'status', 'aria-live': 'polite' });
    this.queueRow = el('p', { class: 'collab-queue' });
    this.refusalRow = el('p', { class: 'collab-refusal', hidden: true, role: 'alert' });
    this.peerList = el('ul', { class: 'collab-peers' });

    this.serverField = el('input', {
      class: 'collab-input',
      type: 'text',
      id: 'collab-server',
      value: 'ws://localhost:8787/sync',
      spellcheck: 'false',
    });
    this.roomField = el('input', {
      class: 'collab-input',
      type: 'text',
      id: 'collab-room',
      value: 'shared-document',
      spellcheck: 'false',
    });
    this.nameField = el('input', {
      class: 'collab-input',
      type: 'text',
      id: 'collab-name',
      value: 'Guest',
    });

    this.connectButton = el('button', {
      class: 'collab-connect',
      type: 'button',
    }) as HTMLButtonElement;
    this.connectButton.addEventListener('click', () => this.toggle());

    this.editor = el('textarea', {
      class: 'collab-editor',
      id: 'collab-editor',
      rows: 12,
      spellcheck: 'false',
      'aria-describedby': 'collab-editor-help',
      placeholder: 'Type here. Everything you type is kept whether or not anybody is connected.',
    }) as HTMLTextAreaElement;
    this.editor.addEventListener('input', () => this.onTyped());
    this.editor.addEventListener('keyup', () => this.reportCaret());
    this.editor.addEventListener('click', () => this.reportCaret());

    this.element = el('section', { class: 'collab', 'aria-label': 'Collaboration' }, [
      el('header', { class: 'collab-header' }, [
        el('h2', { class: 'collab-title', text: 'Collaboration' }),
        el('p', {
          class: 'collab-lede',
          text:
            'Edits are kept on this machine first and shared second. Nothing you type here ' +
            'depends on the server being reachable.',
        }),
      ]),

      el('div', { class: 'collab-connect-row' }, [
        field('Server', 'collab-server', this.serverField, 'The collaboration server to join.'),
        field('Document', 'collab-room', this.roomField, 'Everybody using this name shares one document.'),
        field('Your name', 'collab-name', this.nameField, 'Shown to the other editors.'),
        this.connectButton,
      ]),

      this.statusRow,
      this.queueRow,
      this.refusalRow,

      el('div', { class: 'collab-body' }, [
        el('div', { class: 'collab-editor-pane' }, [
          el('label', { class: 'collab-label', for: 'collab-editor', text: 'Shared document' }),
          this.editor,
          el('p', {
            class: 'collab-help',
            id: 'collab-editor-help',
            text:
              'Two people typing at once both keep their work. The merge happens on every ' +
              'machine independently, so no server decides a winner.',
          }),
        ]),
        el('aside', { class: 'collab-peer-pane' }, [
          el('h3', { class: 'collab-subtitle', text: 'In this document' }),
          this.peerList,
        ]),
      ]),

      el('footer', { class: 'collab-footer' }, [
        el('p', {
          class: 'collab-note',
          text:
            'Not built yet: deleted characters are never collected, so a heavily edited ' +
            'document keeps growing. Collecting them safely needs agreement from every ' +
            'machine that has ever held the document.',
        }),
      ]),
    ]);

    this.render();
  }

  /** The connection, for tests and for the shell. Null until connected. */
  current(): Connection | null {
    return this.connection;
  }

  private toggle(): void {
    if (this.connection !== null) {
      this.connection.disconnect();
      this.connection = null;
      this.peers = [];
      this.state = 'offline';
      this.detail = 'you disconnected';
      this.render();
      return;
    }

    const url = this.serverField.value.trim();
    if (url === '') {
      this.refusal = { reason: 'Give the address of a collaboration server first.', fatal: false };
      this.render();
      return;
    }

    this.refusal = null;
    const events = this.buildEvents();
    const build =
      this.options.connect ??
      ((target: string, on: ConnectionEvents) =>
        new Connection(
          {
            room: this.roomField.value.trim() || 'shared-document',
            replica: 'r-' + Math.random().toString(36).slice(2, 10),
            name: this.nameField.value.trim() || 'Guest',
            open: () => wrap(new WebSocket(target)),
          },
          on,
        ));

    const connection = build(url, events);
    this.connection = connection;
    connection.connect();
    this.render();
  }

  /** The callbacks this surface needs, ready to hand to a connection. */
  private buildEvents(): ConnectionEvents {
    return {
      onState: (state, detail) => {
        this.state = state;
        this.detail = detail;
        this.render();
      },
      onPeers: (peers) => {
        this.peers = peers;
        this.render();
      },
      onRemote: () => {
        const connection = this.connection;
        if (connection === null) return;
        // The caret is held across the rewrite. Without this, somebody typing
        // while a remote edit lands is thrown to the end of the document on
        // every keystroke of everybody else's - the failure people describe as
        // "it keeps jumping".
        this.applying = true;
        const caret = this.editor.selectionStart;
        this.editor.value = connection.document.text();
        this.editor.setSelectionRange(caret, caret);
        this.applying = false;
        this.render();
        this.options.onChange?.();
      },
      onRefusal: (reason, fatal) => {
        this.refusal = { reason, fatal };
        this.render();
      },
    };
  }

  private onTyped(): void {
    if (this.applying) return;
    const connection = this.connection;
    const next = this.editor.value;

    if (connection === null) {
      // No connection yet. The text is still the user's; it simply has nowhere
      // to go, and it will be sent in full once one exists.
      this.render();
      return;
    }

    // Diffed rather than replaced, so a one-character edit is one operation
    // rather than a whole-document rewrite that would fight every other
    // editor's caret.
    const before = connection.document.text();
    const { at, removed, inserted } = diff(before, next);
    if (removed > 0) connection.delete(at, removed);
    if (inserted !== '') connection.insert(at, inserted);

    this.options.onChange?.();
    this.render();
  }

  private reportCaret(): void {
    this.connection?.reportCaret(this.editor.selectionStart);
  }

  private render(): void {
    const style = STATES[this.state];

    clear(this.statusRow);
    this.statusRow.dataset['tone'] = style.tone;
    this.statusRow.append(
      el('span', { class: 'collab-state-emoji', 'aria-hidden': 'true', text: style.emoji }),
      el('span', { class: 'collab-state-label', text: style.label.en }),
      el('span', { class: 'collab-state-detail', text: this.detail === '' ? '' : ' — ' + this.detail }),
    );

    const queued = this.connection?.queued() ?? 0;
    this.queueRow.textContent =
      queued === 0
        ? 'Nothing is waiting to be sent.'
        : queued +
          ' change' +
          (queued === 1 ? '' : 's') +
          ' waiting to be sent. They are safe on this machine and will go out when the ' +
          'connection returns.';

    if (this.refusal === null) {
      this.refusalRow.hidden = true;
      this.refusalRow.textContent = '';
    } else {
      this.refusalRow.hidden = false;
      this.refusalRow.textContent =
        (this.refusal.fatal ? 'The server refused this session: ' : 'The server refused that: ') +
        this.refusal.reason;
    }

    clear(this.peerList);
    if (this.peers.length === 0) {
      this.peerList.append(
        el('li', {
          class: 'collab-peer collab-peer-empty',
          text:
            this.state === 'live'
              ? 'Nobody else is here yet.'
              : 'Not connected, so nobody else can be shown.',
        }),
      );
    } else {
      for (const peer of this.peers) {
        this.peerList.append(
          el('li', { class: 'collab-peer' }, [
            el('span', { class: 'collab-peer-name', text: peer.name }),
            el('span', {
              class: 'collab-peer-caret',
              text: peer.caret === null ? 'position unknown' : 'at character ' + peer.caret,
            }),
          ]),
        );
      }
    }

    this.connectButton.textContent = this.connection === null ? 'Connect' : 'Disconnect';
    this.connectButton.setAttribute(
      'aria-label',
      this.connection === null ? 'Connect to the collaboration server' : 'Disconnect',
    );
  }
}

function field(
  label: string,
  id: string,
  input: HTMLInputElement,
  help: string,
): HTMLElement {
  return el('div', { class: 'collab-field' }, [
    el('label', { class: 'collab-label', for: id, text: label }),
    input,
    el('span', { class: 'collab-help', text: help }),
  ]);
}

/**
 * The smallest single edit between two strings.
 *
 * Not a general diff: a text box produces one contiguous change per input
 * event, so finding the common prefix and suffix is exact for this case and
 * far cheaper than the general algorithm. Sending a whole-document replacement
 * instead would work and would fight every other editor's caret on every
 * keystroke.
 */
export function diff(
  before: string,
  after: string,
): { at: number; removed: number; inserted: string } {
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before[start] === after[start]) start += 1;

  let end = 0;
  while (
    end < shortest - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end += 1;
  }

  return {
    at: start,
    removed: before.length - start - end,
    inserted: after.slice(start, after.length - end),
  };
}

/** Adapt a real WebSocket to the narrow shape the connection needs. */
function wrap(socket: WebSocket): {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
} {
  const adapter = {
    send: (data: string) => socket.send(data),
    close: () => socket.close(),
    onopen: null as (() => void) | null,
    onmessage: null as ((data: string) => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
  };
  socket.addEventListener('open', () => adapter.onopen?.());
  socket.addEventListener('message', (event) => adapter.onmessage?.(String(event.data)));
  socket.addEventListener('close', () => adapter.onclose?.());
  socket.addEventListener('error', () => adapter.onerror?.());
  return adapter;
}
