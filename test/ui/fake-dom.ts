/**
 * The smallest DOM the renderer components touch, installed as a side effect.
 *
 * A separate module rather than a function called from the test, because ESM
 * evaluates imports in order and a component that builds an element at
 * construction needs `document` to exist before its module is evaluated. A
 * `before` hook runs too late, and every test then reports "did not finish
 * before its parent", which reads as a timing flake rather than an ordering
 * mistake.
 *
 * ONE PROPERTY HERE IS LOAD-BEARING, and getting it wrong cost an hour:
 *
 *   `remove()` must ACTUALLY DETACH, and `firstChild` must follow.
 *
 * The first version stubbed `remove()` as a no-op. The renderer's `clear()` is
 * `while (node.firstChild) node.firstChild.remove()` — so once the host had a
 * single child, that loop never terminated. The symptom was the whole test FILE
 * hanging with no per-test output and no error, which reads as a broken test
 * runner rather than as a broken fake. Every probe that pushed only once passed,
 * because the loop is only reached on the second render.
 *
 * A fake that is subtly wrong is worse than no fake: it fails somewhere else,
 * later, in a way that points at the wrong thing.
 */

type Mutable = Record<string, unknown>;

interface FakeNode extends Mutable {
  childNodes: FakeNode[];
  parentNode: FakeNode | null;
}

function makeElement(): FakeNode {
  const childNodes: FakeNode[] = [];

  const element = {
    childNodes,
    parentNode: null as FakeNode | null,
    className: '',
    textContent: '',
    style: { setProperty: () => undefined, removeProperty: () => undefined },

    get firstChild(): FakeNode | null {
      return childNodes[0] ?? null;
    },

    append(...nodes: unknown[]): void {
      for (const node of nodes) {
        if (node === null || node === undefined) continue;
        const child = node as FakeNode;
        if (child && typeof child === 'object') child.parentNode = element as unknown as FakeNode;
        childNodes.push(child);
      }
    },

    replaceChildren(...nodes: unknown[]): void {
      childNodes.length = 0;
      element.append(...nodes);
    },

    /** Genuinely detaches. See the note at the top of this file. */
    remove(): void {
      const parent = element.parentNode;
      if (!parent) return;
      const index = parent.childNodes.indexOf(element as unknown as FakeNode);
      if (index >= 0) parent.childNodes.splice(index, 1);
      element.parentNode = null;
    },

    setAttribute: () => undefined,
    removeAttribute: () => undefined,
    getAttribute: () => null,
    hasAttribute: () => false,
    toggleAttribute: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => [],
    focus: () => undefined,
    contains: () => false,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };

  return element as unknown as FakeNode;
}

function makeTextNode(text: string): FakeNode {
  const node = makeElement();
  node.textContent = text;
  return node;
}

const globals = globalThis as Mutable;

if (!globals.document) {
  globals.document = {
    createElement: () => makeElement(),
    createTextNode: (text: string) => makeTextNode(text),
    createDocumentFragment: () => makeElement(),
    documentElement: makeElement(),
    body: makeElement(),
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
  };
}

if (!globals.window) {
  globals.window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  };
}

// navigator is getter-only on this runtime, so a plain assignment throws before
// a single test runs.
if (!('navigator' in globals)) {
  Object.defineProperty(globals, 'navigator', {
    value: { clipboard: { writeText: () => Promise.resolve() } },
    configurable: true,
    writable: true,
  });
}

export const fakeDomInstalled = true;
