/**
 * A small, safe Markdown renderer.
 *
 * Deliberately builds DOM nodes rather than an HTML string. There is no
 * innerHTML anywhere in here, so a document can never inject markup — and while
 * every article in this project is ours, "our own content is trusted" is exactly
 * the assumption that stops being true the day somebody adds a contributed one.
 *
 * It covers what the articles actually use: headings, paragraphs, lists, tables,
 * fenced code, blockquotes, GitHub alerts, links, inline code, emphasis and
 * horizontal rules. Anything it does not recognise renders as plain text rather
 * than disappearing, because silently dropping a line is worse than showing it
 * unstyled.
 */

export interface Heading {
  level: number;
  text: string;
  id: string;
}

export interface RenderedArticle {
  fragment: DocumentFragment;
  headings: Heading[];
  /** Plain text, for search. */
  text: string;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Inline formatting, appended into a parent as real nodes. */
function inline(parent: Node, source: string): void {
  // Ordered so that code spans win: text inside backticks is never re-parsed,
  // which is why `**not bold**` inside code stays literal.
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    if (match.index > lastIndex) {
      parent.appendChild(document.createTextNode(source.slice(lastIndex, match.index)));
    }
    const [whole] = match;

    if (whole.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = whole.slice(1, -1);
      parent.appendChild(code);
    } else if (whole.startsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = whole.slice(2, -2);
      parent.appendChild(strong);
    } else if (whole.startsWith('*')) {
      const em = document.createElement('em');
      em.textContent = whole.slice(1, -1);
      parent.appendChild(em);
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(whole);
      if (linkMatch) {
        const anchor = document.createElement('a');
        anchor.textContent = linkMatch[1] ?? '';
        const href = linkMatch[2] ?? '';
        anchor.setAttribute('href', href);
        // An external link opens externally and says so to assistive technology.
        if (/^https?:/.test(href)) {
          anchor.setAttribute('target', '_blank');
          anchor.setAttribute('rel', 'noreferrer noopener');
        } else {
          anchor.setAttribute('data-article-link', href);
        }
        parent.appendChild(anchor);
      } else {
        parent.appendChild(document.createTextNode(whole));
      }
    }
    lastIndex = match.index + whole.length;
  }

  if (lastIndex < source.length) {
    parent.appendChild(document.createTextNode(source.slice(lastIndex)));
  }
}

const ALERT = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/;

export function renderMarkdown(source: string): RenderedArticle {
  const fragment = document.createDocumentFragment();
  const headings: Heading[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let index = 0;

  const plain: string[] = [];

  while (index < lines.length) {
    const line = lines[index] ?? '';

    // Fenced code
    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').startsWith('```')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (language) code.setAttribute('data-language', language);
      code.textContent = body.join('\n');
      pre.appendChild(code);
      fragment.appendChild(pre);
      plain.push(body.join(' '));
      continue;
    }

    // Heading
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      const level = (headingMatch[1] ?? '#').length;
      const text = headingMatch[2] ?? '';
      const id = slug(text);
      const node = document.createElement('h' + Math.min(level + 1, 6));
      node.id = id;
      inline(node, text);
      fragment.appendChild(node);
      headings.push({ level, text, id });
      plain.push(text);
      index += 1;
      continue;
    }

    // Table
    if (line.startsWith('|') && (lines[index + 1] ?? '').replace(/[\s|:-]/g, '') === '') {
      const table = document.createElement('table');
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const cell of line.split('|').slice(1, -1)) {
        const th = document.createElement('th');
        th.setAttribute('scope', 'col');
        inline(th, cell.trim());
        headRow.appendChild(th);
      }
      head.appendChild(headRow);
      table.appendChild(head);

      const body = document.createElement('tbody');
      index += 2;
      while (index < lines.length && (lines[index] ?? '').startsWith('|')) {
        const row = document.createElement('tr');
        for (const cell of (lines[index] ?? '').split('|').slice(1, -1)) {
          const td = document.createElement('td');
          inline(td, cell.trim());
          row.appendChild(td);
          plain.push(cell.trim());
        }
        body.appendChild(row);
        index += 1;
      }
      table.appendChild(body);
      fragment.appendChild(table);
      continue;
    }

    // Blockquote, including GitHub alerts
    if (line.startsWith('>')) {
      const alertMatch = ALERT.exec(line);
      const quote = document.createElement('blockquote');
      if (alertMatch) {
        quote.setAttribute('data-alert', (alertMatch[1] ?? '').toLowerCase());
        const label = document.createElement('p');
        label.className = 'alert__label';
        label.textContent = (alertMatch[1] ?? '').toLowerCase();
        quote.appendChild(label);
        index += 1;
      }
      const body: string[] = [];
      while (index < lines.length && (lines[index] ?? '').startsWith('>')) {
        body.push((lines[index] ?? '').replace(/^>\s?/, ''));
        index += 1;
      }
      const paragraph = document.createElement('p');
      inline(paragraph, body.join(' ').trim());
      quote.appendChild(paragraph);
      fragment.appendChild(quote);
      plain.push(body.join(' '));
      continue;
    }

    // Lists
    if (/^\s*[-*]\s+/.test(line)) {
      const list = document.createElement('ul');
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] ?? '')) {
        const item = document.createElement('li');
        const text = (lines[index] ?? '').replace(/^\s*[-*]\s+/, '');
        inline(item, text);
        list.appendChild(item);
        plain.push(text);
        index += 1;
      }
      fragment.appendChild(list);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const list = document.createElement('ol');
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? '')) {
        const item = document.createElement('li');
        const text = (lines[index] ?? '').replace(/^\s*\d+\.\s+/, '');
        inline(item, text);
        list.appendChild(item);
        plain.push(text);
        index += 1;
      }
      fragment.appendChild(list);
      continue;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(line.trim())) {
      fragment.appendChild(document.createElement('hr'));
      index += 1;
      continue;
    }

    // Blank
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    // Paragraph: gather until a blank line or a construct starts.
    const body: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? '').trim().length > 0 &&
      !/^(#{1,6}\s|```|>|\s*[-*]\s|\s*\d+\.\s|\|)/.test(lines[index] ?? '')
    ) {
      body.push(lines[index] ?? '');
      index += 1;
    }
    if (body.length > 0) {
      const paragraph = document.createElement('p');
      inline(paragraph, body.join(' '));
      fragment.appendChild(paragraph);
      plain.push(body.join(' '));
    }
  }

  return { fragment, headings, text: plain.join(' ') };
}
