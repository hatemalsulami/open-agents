// Minimal, safe markdown renderer for assistant messages.
// Builds DOM nodes directly — no innerHTML anywhere, so page-derived text in a
// model reply can never inject markup into the panel.

function renderInline(text, parent) {
  // links, bold, italics, inline code
  const pattern = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\*([^*]+)\*)|(https?:\/\/\S+)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    if (match[1]) {
      parent.appendChild(anchor(match[3], match[2]));
    } else if (match[4]) {
      const strong = document.createElement('strong');
      strong.textContent = match[5];
      parent.appendChild(strong);
    } else if (match[6]) {
      const code = document.createElement('code');
      code.textContent = match[7];
      parent.appendChild(code);
    } else if (match[8]) {
      const em = document.createElement('em');
      em.textContent = match[9];
      parent.appendChild(em);
    } else if (match[10]) {
      parent.appendChild(anchor(match[10], match[10]));
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    parent.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

function anchor(href, label) {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noreferrer noopener';
  a.textContent = label;
  return a;
}

/** @returns {DocumentFragment} */
export function renderMarkdown(text) {
  const fragment = document.createDocumentFragment();
  const lines = String(text || '').split('\n');
  let list = null;

  const closeList = () => {
    if (list) fragment.appendChild(list);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = /^```/.test(line);
    if (fence) {
      closeList();
      const pre = document.createElement('pre');
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      pre.textContent = body.join('\n');
      fragment.appendChild(pre);
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const h = document.createElement(`h${Math.min(heading[1].length + 2, 6)}`);
      renderInline(heading[2], h);
      fragment.appendChild(h);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const wantOrdered = !!numbered;
      if (!list || list.tagName !== (wantOrdered ? 'OL' : 'UL')) {
        closeList();
        list = document.createElement(wantOrdered ? 'ol' : 'ul');
      }
      const li = document.createElement('li');
      renderInline((bullet || numbered)[1], li);
      list.appendChild(li);
      continue;
    }

    closeList();
    if (!line.trim()) continue;
    const p = document.createElement('p');
    renderInline(line, p);
    fragment.appendChild(p);
  }

  closeList();
  return fragment;
}
