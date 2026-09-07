/**
 * Small DOM helpers.
 *
 * No framework: the application owns its own rendering, so there is no
 * dependency to bundle, no version to track, and nothing between the code and
 * what the browser actually does.
 */

type Attributes = Record<string, string | number | boolean | null | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') node.className = String(value);
    else if (name === 'text') node.textContent = String(value);
    else if (value === true) node.setAttribute(name, '');
    else node.setAttribute(name, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.firstChild.remove();
}

export function mount(node: Element, ...children: (Node | null | undefined)[]): void {
  clear(node);
  for (const child of children) {
    if (child) node.append(child);
  }
}

/**
 * Format an instant for display: the local date and time, to the SECOND, with
 * the timezone named.
 *
 * Seconds and the timezone label are both required rather than decorative. A
 * timestamp with no zone is ambiguous by up to a day, and a build time rounded
 * to the minute cannot distinguish two builds made in the same minute — which is
 * exactly what happens during a release.
 */
export function formatInstant(iso: string | null): { text: string; unavailable: boolean } {
  if (!iso) return { text: '', unavailable: true };
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return { text: '', unavailable: true };

  const formatter = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });
  return { text: formatter.format(parsed), unavailable: false };
}

/** The resolved timezone identifier, so the label can name it exactly. */
export function timezoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  } catch {
    return 'local time';
  }
}
