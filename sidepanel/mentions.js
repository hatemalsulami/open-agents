// Tab mentions: type "@" in the composer to point an agent at specific tabs.
// The mentioned tabs become the agent's scope — it starts there, and can be
// locked to those sites entirely.

import { t } from '../ui/i18n.js';
import { icon } from '../ui/icons.js';

const RESTRICTED = /^(chrome|chrome-extension|edge|about|devtools|view-source):/i;

export function createMentionController({ textarea, chipsEl, overlayEl, onChange }) {
  let mentions = []; // [{ tabId, url, title, favIconUrl }]
  let restrictOrigins = false;
  let candidates = [];
  let highlighted = 0;
  let triggerIndex = -1; // where the active "@" sits in the textarea

  // ------------------------------------------------------------- chips

  function renderChips() {
    chipsEl.innerHTML = '';
    chipsEl.classList.toggle('hidden', mentions.length === 0);
    if (!mentions.length) return;

    const label = document.createElement('span');
    label.className = 'mention-label';
    label.textContent = t('mentions.title');
    chipsEl.appendChild(label);

    for (const mention of mentions) {
      const chip = document.createElement('span');
      chip.className = 'mention-chip';
      chip.title = mention.url;

      if (mention.favIconUrl) {
        const favicon = document.createElement('img');
        favicon.src = mention.favIconUrl;
        favicon.alt = '';
        chip.appendChild(favicon);
      }
      const text = document.createElement('span');
      text.className = 'mention-text';
      text.textContent = mention.title || hostOf(mention.url);
      const remove = document.createElement('button');
      remove.className = 'mention-remove';
      remove.appendChild(icon('x', { size: 11 }));
      remove.title = t('mentions.remove');
      remove.addEventListener('click', () => {
        mentions = mentions.filter((m) => m.tabId !== mention.tabId);
        renderChips();
        onChange?.();
      });
      chip.append(text, remove);
      chipsEl.appendChild(chip);
    }

    const lock = document.createElement('button');
    lock.className = `mention-lock${restrictOrigins ? ' on' : ''}`;
    lock.appendChild(icon(restrictOrigins ? 'lock' : 'unlock', { size: 12 }));
    lock.title = t(restrictOrigins ? 'mentions.lockOn' : 'mentions.lockOff');
    lock.addEventListener('click', () => {
      restrictOrigins = !restrictOrigins;
      renderChips();
    });
    chipsEl.appendChild(lock);
  }

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  // ----------------------------------------------------------- picker

  function closePicker() {
    overlayEl.classList.add('hidden');
    overlayEl.innerHTML = '';
    triggerIndex = -1;
    candidates = [];
  }

  function renderPicker() {
    overlayEl.innerHTML = '';
    overlayEl.classList.remove('hidden');

    if (!candidates.length) {
      const empty = document.createElement('div');
      empty.className = 'mention-empty';
      empty.textContent = t('mentions.empty');
      overlayEl.appendChild(empty);
      return;
    }

    candidates.forEach((tab, index) => {
      const row = document.createElement('div');
      row.className = `mention-option${index === highlighted ? ' active' : ''}`;

      if (tab.favIconUrl) {
        const favicon = document.createElement('img');
        favicon.src = tab.favIconUrl;
        favicon.alt = '';
        row.appendChild(favicon);
      }
      const title = document.createElement('span');
      title.className = 'mention-option-title';
      title.textContent = tab.title || hostOf(tab.url);
      const host = document.createElement('span');
      host.className = 'mention-option-host';
      host.textContent = hostOf(tab.url);
      row.append(title, host);

      // mousedown, not click: the textarea must not lose focus first.
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        choose(index);
      });
      overlayEl.appendChild(row);
    });
  }

  async function openPicker(query) {
    const tabs = await chrome.tabs.query({});
    const mentioned = new Set(mentions.map((m) => m.tabId));
    const needle = query.toLowerCase();

    candidates = tabs
      .filter((tab) => !RESTRICTED.test(tab.url || '') && !mentioned.has(tab.id))
      .filter((tab) => !needle || `${tab.title} ${tab.url}`.toLowerCase().includes(needle))
      .slice(0, 8);

    highlighted = 0;
    renderPicker();
  }

  function choose(index) {
    const tab = candidates[index];
    if (!tab) return closePicker();

    mentions.push({ tabId: tab.id, url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl });

    // Replace the typed "@query" with a readable label.
    const value = textarea.value;
    const label = `@${(tab.title || hostOf(tab.url)).slice(0, 30)} `;
    const caret = textarea.selectionStart;
    textarea.value = value.slice(0, triggerIndex) + label + value.slice(caret);
    const position = triggerIndex + label.length;
    textarea.setSelectionRange(position, position);

    closePicker();
    renderChips();
    textarea.focus();
    onChange?.();
  }

  // ------------------------------------------------------------ input

  function onInput() {
    const caret = textarea.selectionStart;
    const before = textarea.value.slice(0, caret);
    // An "@" only triggers at a word boundary, so emails and handles mid-word
    // don't pop the picker open.
    const match = /(^|\s)@([^\s@]*)$/.exec(before);

    if (!match) return closePicker();
    triggerIndex = caret - match[2].length - 1;
    openPicker(match[2]);
  }

  function onKeyDown(event) {
    if (overlayEl.classList.contains('hidden')) return false;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        highlighted = (highlighted + 1) % Math.max(candidates.length, 1);
        renderPicker();
        return true;
      case 'ArrowUp':
        event.preventDefault();
        highlighted = (highlighted - 1 + candidates.length) % Math.max(candidates.length, 1);
        renderPicker();
        return true;
      case 'Enter':
      case 'Tab':
        event.preventDefault();
        choose(highlighted);
        return true;
      case 'Escape':
        event.preventDefault();
        closePicker();
        return true;
      default:
        return false;
    }
  }

  textarea.addEventListener('input', onInput);
  textarea.addEventListener('blur', () => setTimeout(closePicker, 120));

  return {
    /** @returns true when the key was consumed by the picker */
    handleKeyDown: onKeyDown,
    getMentions: () => mentions.map(({ tabId, url, title }) => ({ tabId, url, title })),
    getRestrictOrigins: () => restrictOrigins && mentions.length > 0,
    clear() {
      mentions = [];
      restrictOrigins = false;
      closePicker();
      renderChips();
    },
    refreshLabels: renderChips,
  };
}
