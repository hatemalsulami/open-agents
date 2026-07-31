// Inline SVG icon set. Emoji render differently on every OS, sit on the text
// baseline, and can't inherit color — so the UI uses these instead.
//
// Icons are built with createElementNS rather than innerHTML: same no-raw-markup
// rule the rest of the UI follows, and it keeps every icon a real DOM node that
// inherits `currentColor` from its button.

const NS = 'http://www.w3.org/2000/svg';

// 24×24 stroke geometry. A string is a <path d="…">; an object is any other
// element, e.g. { tag: 'circle', attrs: {…} }.
const ICONS = {
  chat: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  board: ['M3 3h7v9H3z', 'M14 3h7v5h-7z', 'M14 12h7v9h-7z', 'M3 16h7v5H3z'],
  clock: [{ tag: 'circle', attrs: { cx: 12, cy: 12, r: 9 } }, 'M12 7v5l3.5 2'],
  book: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'],
  volumeOn: ['M11 5 6 9H3v6h3l5 4z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M18.5 5.5a9 9 0 0 1 0 13'],
  volumeOff: ['M11 5 6 9H3v6h3l5 4z', 'M17 9.5l5 5', 'M22 9.5l-5 5'],
  globe: [
    { tag: 'circle', attrs: { cx: 12, cy: 12, r: 9 } },
    'M3 12h18',
    'M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18',
  ],
  sliders: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
  gauge: ['M12 14l4-4', 'M3.6 18a9 9 0 1 1 16.8 0'],
  plus: ['M12 5v14', 'M5 12h14'],
  x: ['M18 6 6 18', 'M6 6l12 12'],
  play: ['M6 4l14 8-14 8z'],
  pause: ['M7 4h3v16H7z', 'M14 4h3v16h-3z'],
  pencil: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 15H6L5 6', 'M10 11v6', 'M14 11v6'],
  pin: ['M12 17v5', 'M8 3h8', 'M9 3v7.5L6.5 15h11L15 10.5V3'],
  download: ['M12 3v12', 'M7 10l5 5 5-5', 'M4 21h16'],
  braces: [
    'M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1',
    'M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1',
  ],
  lock: [{ tag: 'rect', attrs: { x: 4, y: 11, width: 16, height: 10, rx: 2 } }, 'M8 11V7a4 4 0 0 1 8 0v4'],
  unlock: [{ tag: 'rect', attrs: { x: 4, y: 11, width: 16, height: 10, rx: 2 } }, 'M8 11V7a4 4 0 0 1 7.5-1.5'],
  send: ['M21 3 10.5 13.5', 'M21 3l-7 18-3.5-7.5L3 10z'],
  stop: [{ tag: 'rect', attrs: { x: 5, y: 5, width: 14, height: 14, rx: 2 } }],
  refresh: ['M20.5 12a8.5 8.5 0 1 1-2.6-6.1', 'M21 3v5h-5'],
  external: ['M14 3h7v7', 'M10 14 21 3', 'M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  note: ['M5 4h14v16H5z', 'M9 9h6', 'M9 13h6', 'M9 17h3'],
  bug: [
    { tag: 'rect', attrs: { x: 8, y: 6, width: 8, height: 14, rx: 4 } },
    'M8 12H4', 'M20 12h-4', 'M8 17l-3 2', 'M16 17l3 2', 'M8 8L5 6', 'M16 8l3-2',
  ],
  sparkle: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z'],
  check: ['M4 12.5 9 17.5 20 6.5'],
  circle: [{ tag: 'circle', attrs: { cx: 12, cy: 12, r: 8 } }],
  circleDot: [
    { tag: 'circle', attrs: { cx: 12, cy: 12, r: 8 } },
    { tag: 'circle', attrs: { cx: 12, cy: 12, r: 3.5, fill: 'currentColor', stroke: 'none' } },
  ],
  spinner: ['M12 3a9 9 0 1 0 9 9'],
  mic: ['M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v4', 'M8 23h8'],
};

/** Builds an icon element. @returns {SVGElement} */
export function icon(name, { size = 18, strokeWidth = 2 } = {}) {
  const shapes = ICONS[name] || ICONS.sparkle;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');

  for (const shape of shapes) {
    if (typeof shape === 'string') {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', shape);
      svg.appendChild(path);
    } else {
      const el = document.createElementNS(NS, shape.tag);
      for (const [key, value] of Object.entries(shape.attrs)) el.setAttribute(key, String(value));
      svg.appendChild(el);
    }
  }
  return svg;
}

/** Replaces an element's contents with a single icon. */
export function setIcon(el, name, options) {
  el.replaceChildren(icon(name, options));
  return el;
}

/**
 * Fills every [data-icon] element in `root`.
 *
 * The icon is INSERTED as the first child rather than replacing the contents,
 * so a button can carry both an icon and a text label (the nav tabs do, and
 * their labels are filled separately by the i18n pass). Idempotent: calling it
 * again — e.g. after a language switch — swaps the existing icon in place
 * instead of stacking a second one.
 */
export function applyIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    const options = el.dataset.iconSize ? { size: Number(el.dataset.iconSize) } : undefined;
    const svg = icon(el.dataset.icon, options);
    const existing = el.querySelector(':scope > svg.icon');
    if (existing) existing.replaceWith(svg);
    else el.insertBefore(svg, el.firstChild);
  }
}

/** A button element that is just an icon, with an accessible label. */
export function iconButton(name, label, onClick, { className = 'icon-btn', size } = {}) {
  const button = document.createElement('button');
  button.className = className;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.appendChild(icon(name, size ? { size } : undefined));
  if (onClick) button.addEventListener('click', onClick);
  return button;
}
