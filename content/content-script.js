// OpenAgent content script — injected on demand by the background service worker.
// Provides page reading (an indexed outline of interactive elements) and input
// actions (click, type, select, scroll, key presses) for the agent loop.
//
// Everything here treats page content as untrusted data. The script never
// executes instructions found in the page; it only reports what it sees.

(() => {
  if (window.__openAgent) return;

  const state = {
    refs: new Map(), // "ref12" -> Element, rebuilt on every read_page
    refCounter: 0,
  };
  window.__openAgent = state;


  // ---------------------------------------------------------------- overlay
  //
  // Visible feedback on the page itself: a scanning sweep while the agent
  // reads, and a pulse around whatever it clicks or types into. Everything
  // lives in a shadow root so page styles cannot alter it and it cannot alter
  // the page — and it is pointer-events:none so it never intercepts a click.

  let overlayRoot = null;

  function ensureOverlay() {
    if (overlayRoot?.host?.isConnected) return overlayRoot;

    const host = document.createElement('div');
    host.id = '__openagent_overlay';
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    (document.body || document.documentElement).appendChild(host);

    overlayRoot = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { pointer-events: none; }
      .frame {
        position: fixed; inset: 0; pointer-events: none;
        border: 2px solid rgba(124,108,245,.85);
        box-shadow: inset 0 0 22px rgba(124,108,245,.32);
        opacity: 0; transition: opacity .18s ease;
      }
      .frame.on { opacity: 1; }
      .sweep {
        position: fixed; left: 0; right: 0; height: 130px; pointer-events: none;
        background: linear-gradient(180deg, transparent, rgba(124,108,245,.28), transparent);
        opacity: 0; will-change: transform;
      }
      .sweep.on { opacity: 1; animation: scan 1.5s cubic-bezier(.4,0,.6,1) infinite; }
      @keyframes scan { from { transform: translateY(-130px); } to { transform: translateY(100vh); } }
      .badge {
        position: fixed; top: 14px; inset-inline-end: 14px; pointer-events: none;
        display: flex; align-items: center; gap: 8px;
        background: rgba(17,19,25,.92); color: #e8eaf0;
        font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        padding: 8px 13px; border-radius: 999px;
        box-shadow: 0 6px 22px rgba(0,0,0,.4);
        opacity: 0; transform: translateY(-6px); transition: opacity .18s, transform .18s;
        max-width: 320px;
      }
      .badge.on { opacity: 1; transform: none; }
      .badge .dot {
        width: 8px; height: 8px; border-radius: 50%; background: #7c6cf5;
        animation: pulse 1s ease-in-out infinite; flex: none;
      }
      @keyframes pulse { 50% { opacity: .25; transform: scale(.72); } }
      .badge .label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .spot {
        position: fixed; pointer-events: none; border-radius: 7px;
        border: 2px solid #7c6cf5; background: rgba(124,108,245,.16);
        box-shadow: 0 0 0 3px rgba(124,108,245,.22);
        animation: spot .9s ease-out forwards;
      }
      @keyframes spot {
        0% { opacity: 0; transform: scale(1.28); }
        22% { opacity: 1; transform: scale(1); }
        100% { opacity: 0; transform: scale(1); }
      }
      @media (prefers-reduced-motion: reduce) {
        .sweep.on { animation: none; opacity: .3; }
        .badge .dot, .spot { animation: none; }
        .spot { opacity: 1; }
      }
    `;

    const frame = document.createElement('div');
    frame.className = 'frame';
    const sweep = document.createElement('div');
    sweep.className = 'sweep';
    const badge = document.createElement('div');
    badge.className = 'badge';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.className = 'label';
    badge.append(dot, label);

    overlayRoot.append(style, frame, sweep, badge);
    overlayRoot.__parts = { frame, sweep, badge, label };
    return overlayRoot;
  }

  let busyTimer = null;

  function showActivity(text, { scanning = false } = {}) {
    const { frame, sweep, badge, label } = ensureOverlay().__parts;
    label.textContent = text;
    badge.classList.add('on');
    frame.classList.add('on');
    sweep.classList.toggle('on', scanning);

    // Self-clearing: if the agent dies mid-step the page is not left glowing.
    clearTimeout(busyTimer);
    busyTimer = setTimeout(hideActivity, 8000);
  }

  function hideActivity() {
    if (!overlayRoot?.host?.isConnected) return;
    const { frame, sweep, badge } = overlayRoot.__parts;
    badge.classList.remove('on');
    frame.classList.remove('on');
    sweep.classList.remove('on');
  }

  function flashElement(el) {
    const rect = el.getBoundingClientRect();
    const spot = document.createElement('div');
    spot.className = 'spot';
    spot.style.cssText = `top:${rect.top - 3}px; left:${rect.left - 3}px; width:${rect.width + 6}px; height:${rect.height + 6}px;`;
    ensureOverlay().appendChild(spot);
    setTimeout(() => spot.remove(), 950);
  }

  const INTERACTIVE_SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="combobox"]', '[role="listbox"]', '[role="menuitem"]', '[role="tab"]',
    '[role="switch"]', '[role="option"]', '[role="searchbox"]', '[role="textbox"]',
    '[contenteditable="true"]', '[onclick]',
  ].join(',');

  const OUTLINE_SELECTOR = `h1, h2, h3, ${INTERACTIVE_SELECTOR}`;

  function isVisible(el) {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function truncate(text, max = 90) {
    text = (text || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  function describeElement(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    let kind = role || tag;
    if (tag === 'input') kind = `input(${el.type || 'text'})`;
    if (tag === 'a') kind = 'link';

    const parts = [];
    const label =
      el.getAttribute('aria-label') ||
      truncate(el.innerText) ||
      el.getAttribute('placeholder') ||
      el.getAttribute('alt') ||
      el.getAttribute('title') ||
      el.getAttribute('name') ||
      '';
    if (label) parts.push(`"${truncate(label)}"`);

    if (tag === 'input' || tag === 'textarea') {
      if (el.placeholder && el.placeholder !== label) parts.push(`placeholder="${truncate(el.placeholder, 50)}"`);
      if (el.value) parts.push(`value="${truncate(el.value, 50)}"`);
      if (el.checked) parts.push('checked');
    }
    if (tag === 'select') {
      const selected = el.selectedOptions[0];
      if (selected) parts.push(`selected="${truncate(selected.textContent, 50)}"`);
    }
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href && !href.startsWith('javascript:')) parts.push(`href=${truncate(href, 80)}`);
    }
    if (el.disabled) parts.push('disabled');
    return { kind, detail: parts.join(' ') };
  }

  function readPage(input) {
    const filter = input.filter || 'interactive';
    showActivity('Reading this page…', { scanning: true });
    state.refs.clear();
    state.refCounter = 0;

    const lines = [
      `Page: ${truncate(document.title, 150)}`,
      `URL: ${location.href}`,
      `Scroll: ${Math.round(window.scrollY)}px of ${Math.max(0, document.documentElement.scrollHeight - window.innerHeight)}px`,
      '',
    ];

    const elements = document.querySelectorAll(filter === 'all' ? OUTLINE_SELECTOR : INTERACTIVE_SELECTOR);
    // The caller sets the budget from the model's context size: a small
    // on-device model cannot swallow a page like YouTube whole.
    let budget = Math.max(400, Number(input.max_chars) || 16000);
    const needle = (input.query || '').toLowerCase();
    let skipped = 0;

    for (const el of elements) {
      if (!isVisible(el)) continue;
      let line;
      const tag = el.tagName.toLowerCase();
      if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
        line = `${'#'.repeat(Number(tag[1]))} ${truncate(el.innerText, 120)}`;
      } else {
        const ref = `ref${++state.refCounter}`;
        state.refs.set(ref, el);
        const { kind, detail } = describeElement(el);
        line = `[${ref}] ${kind} ${detail}`.trimEnd();
      }
      if (needle && !line.toLowerCase().includes(needle)) { skipped++; continue; }
      if (budget - line.length < 0) { skipped++; continue; }
      budget -= line.length + 1;
      lines.push(line);
    }

    if (state.refCounter === 0) lines.push('(no interactive elements found — try get_page_text or screenshot)');
    if (skipped > 0) {
      lines.push(
        `…${skipped} more elements not shown. Use find("what you are looking for") to jump straight to one, ` +
        'or read_page with a query filter — do not just re-read the whole page.'
      );
    }
    return lines.join('\n');
  }

  function getPageText(input = {}) {
    showActivity('Reading this page…', { scanning: true });
    const root = document.querySelector('main, article, [role="main"]') || document.body;
    const text = (root.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    const max = Math.max(400, Number(input.max_chars) || 20000);
    const header = `Page: ${truncate(document.title, 150)}\nURL: ${location.href}\n\n`;
    return header + (text.length > max ? text.slice(0, max) + `\n\n…truncated (${text.length} chars total)` : text);
  }


  // Targeted lookups that return a handful of lines instead of a whole page —
  // the difference between usable and unusable on a small-context model.

  function scoreMatch(haystack, tokens) {
    const text = haystack.toLowerCase();
    let score = 0;
    for (const token of tokens) if (text.includes(token)) score += token.length;
    return score;
  }

  function findElements(input) {
    const query = String(input.query || '').trim();
    if (!query) throw new Error('find needs a "query" describing what you are looking for.');
    showActivity(`Looking for “${truncate(query, 30)}”`, { scanning: true });

    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const limit = Math.min(Math.max(Number(input.limit) || 6, 1), 15);

    // Refs must stay valid, so this extends the existing map instead of
    // clearing it — find() and read_page() can be interleaved safely.
    const scored = [];
    for (const el of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
      if (!isVisible(el)) continue;
      const { kind, detail } = describeElement(el);
      const score = scoreMatch(`${kind} ${detail}`, tokens);
      if (score > 0) scored.push({ el, kind, detail, score });
    }
    scored.sort((a, b) => b.score - a.score);

    if (!scored.length) {
      return `No visible element matches "${query}". Try get_page_text to see what is on the page, or scroll first.`;
    }

    const lines = scored.slice(0, limit).map(({ el, kind, detail }) => {
      let ref = null;
      for (const [key, value] of state.refs) if (value === el) ref = key;
      if (!ref) {
        ref = `ref${++state.refCounter}`;
        state.refs.set(ref, el);
      }
      return `[${ref}] ${kind} ${detail}`.trimEnd();
    });
    return `Best matches for "${query}":\n${lines.join('\n')}`;
  }

  function extractLinks(input) {
    showActivity('Collecting links…', { scanning: true });
    const tokens = String(input.query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const limit = Math.min(Math.max(Number(input.limit) || 15, 1), 40);
    const seen = new Set();
    const rows = [];

    for (const a of document.querySelectorAll('a[href]')) {
      if (!isVisible(a)) continue;
      const href = a.href;
      if (!/^https?:/i.test(href) || seen.has(href)) continue;
      const label = truncate(a.innerText || a.getAttribute('aria-label') || a.title, 70);
      if (!label) continue;
      if (tokens.length && !scoreMatch(`${label} ${href}`, tokens)) continue;
      seen.add(href);
      rows.push(`- ${label} → ${href}`);
      if (rows.length >= limit) break;
    }
    return rows.length ? rows.join('\n') : 'No matching links found on this page.';
  }

  function readSection(input) {
    const query = String(input.query || '').trim();
    if (!query) throw new Error('read_section needs a "query" naming the section you want.');
    showActivity(`Reading “${truncate(query, 30)}”`, { scanning: true });

    const max = Math.max(300, Number(input.max_chars) || 1500);
    const root = document.querySelector('main, article, [role="main"]') || document.body;
    const blocks = [...root.querySelectorAll('p, li, h1, h2, h3, h4, td, dd, blockquote')]
      .filter(isVisible)
      .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
      .filter((text) => text.length > 20);

    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = blocks
      .map((text, index) => ({ text, index, score: scoreMatch(text, tokens) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    if (!hits.length) return `Nothing on this page mentions "${query}".`;

    let out = '';
    for (const hit of hits.sort((a, b) => a.index - b.index)) {
      if (out.length + hit.text.length > max) break;
      out += `${hit.text}\n\n`;
    }
    return out.trim() || blocks[hits[0].index].slice(0, max);
  }

  function elementRect(input) {
    const el = resolveRef(input.ref);
    if (input.guardPassword && el instanceof HTMLInputElement && el.type === 'password') {
      throw new Error('Refusing to type into a password field. Ask the user to sign in themselves.');
    }
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) {
      throw new Error(`Element ${input.ref} has no size or is off-screen; look again.`);
    }
    const { kind, detail } = describeElement(el);
    // CSS pixels relative to the viewport — what CDP Input expects.
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      w: r.width,
      h: r.height,
      label: (detail || kind).slice(0, 60),
    };
  }

  function resolveRef(ref) {
    const el = state.refs.get(ref);
    if (!el || !el.isConnected) {
      throw new Error(`Unknown or stale ref "${ref}". Call read_page to get fresh refs.`);
    }
    return el;
  }

  function dispatchClickSequence(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
      button: 0,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  // Sets the value through the native setter so frameworks like React that
  // patch the value property still see the change, then fires input events.
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function typeText(input) {
    const el = resolveRef(input.ref);
    if (el instanceof HTMLInputElement && el.type === 'password') {
      throw new Error('Refusing to type into a password field. Ask the user to sign in themselves.');
    }
    el.scrollIntoView({ block: 'center' });
    showActivity(`Typing “${truncate(input.text, 30)}”`);
    flashElement(el);
    el.focus();

    if (el.isContentEditable) {
      el.textContent = input.text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: input.text, inputType: 'insertText' }));
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      setNativeValue(el, input.text);
    } else {
      throw new Error(`Element ${input.ref} is not a text input.`);
    }

    if (input.press_enter) {
      pressKeyOn(el, 'Enter');
      const form = el.form;
      if (form && el.isConnected && document.activeElement === el) {
        try { form.requestSubmit(); } catch { /* some forms have no submitter */ }
      }
    }
    return `Typed into ${input.ref}${input.press_enter ? ' and pressed Enter' : ''}.`;
  }

  const KEY_CODES = {
    Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ' ': 32,
    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    Home: 36, End: 35, PageUp: 33, PageDown: 34,
  };

  function pressKeyOn(el, key) {
    const keyCode = KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const opts = { bubbles: true, cancelable: true, composed: true, key, code: key, keyCode, which: keyCode };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  const handlers = {
    ping: () => 'pong',
    activity: (input) => {
      if (input.done) hideActivity();
      else showActivity(input.text || 'Working…', { scanning: !!input.scanning });
      return 'ok';
    },
    read_page: readPage,
    get_page_text: getPageText,
    find: findElements,
    extract_links: extractLinks,
    read_section: readSection,
    element_rect: elementRect,

    click: (input) => {
      const el = resolveRef(input.ref);
      const { kind, detail } = describeElement(el);
      showActivity(`Clicking ${truncate(detail || kind, 40)}`);
      flashElement(el);
      dispatchClickSequence(el);
      return `Clicked [${input.ref}] ${kind} ${detail}`.trimEnd();
    },

    type_text: typeText,

    select_option: (input) => {
      const el = resolveRef(input.ref);
      if (!(el instanceof HTMLSelectElement)) throw new Error(`${input.ref} is not a <select> element.`);
      const target = [...el.options].find(
        (o) => o.value === input.value || o.textContent.trim() === input.value
      );
      if (!target) {
        const available = [...el.options].map((o) => o.textContent.trim()).slice(0, 30).join(' | ');
        throw new Error(`Option "${input.value}" not found. Available: ${available}`);
      }
      el.value = target.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return `Selected "${truncate(target.textContent, 60)}" in ${input.ref}.`;
    },

    scroll: (input) => {
      if (input.ref) {
        resolveRef(input.ref).scrollIntoView({ block: 'center' });
        return `Scrolled ${input.ref} into view.`;
      }
      const page = window.innerHeight * 0.85;
      switch (input.direction) {
        case 'top': window.scrollTo(0, 0); break;
        case 'bottom': window.scrollTo(0, document.documentElement.scrollHeight); break;
        case 'up': window.scrollBy(0, -(input.amount ?? page)); break;
        default: window.scrollBy(0, input.amount ?? page);
      }
      return `Scrolled. Now at ${Math.round(window.scrollY)}px of ${Math.max(0, document.documentElement.scrollHeight - window.innerHeight)}px.`;
    },

    press_key: (input) => {
      pressKeyOn(document.activeElement || document.body, input.key);
      return `Pressed ${input.key}.`;
    },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.__openAgent !== true) return false;
    try {
      const handler = handlers[msg.name];
      if (!handler) throw new Error(`Unknown page tool: ${msg.name}`);
      const result = handler(msg.input || {});
      sendResponse({ ok: true, result });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
    return false; // all handlers are synchronous
  });
})();
