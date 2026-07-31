// Browser tool definitions (JSON Schema, provider-neutral) and their executors.
// Page tools are proxied to the content script; tab/navigation/screenshot tools
// run here in the service worker.

import { checkTabAllowed, checkUrlAllowed, admitTab } from './scope.js';
import { searchKnowledge } from './knowledge.js';
import * as cdp from './cdp.js';

const INPUT_TOOLS = new Set(['click', 'type_text', 'press_key']);

const RESTRICTED_URL = /^(chrome|chrome-extension|edge|about|devtools|view-source):/i;

export const TOOL_DEFINITIONS = [
  {
    name: 'batch',
    description:
      'Run several actions in ONE call — the cheapest way to work. Example: click a field, type into it, wait, then read the result. Actions run in order and STOP at the first failure (element refs go stale after a page changes), and you get the result of each. Use this whenever you already know the next 2-6 actions; it saves the user real money. Do not nest a batch inside a batch.',
    input_schema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: 'Up to 8 actions, run in order.',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', description: 'Any tool name except "batch".' },
              input: { type: 'object', description: "That tool's arguments." },
            },
            required: ['tool'],
          },
        },
      },
      required: ['actions'],
    },
  },
  {
    name: 'search_knowledge',
    description:
      "Search the user's own saved notes and files (their knowledge base) for facts about their work: store URLs, account details, project context, data dictionaries, past decisions. Check here BEFORE browsing or guessing — it is free, instant, and authoritative for anything about the user.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to know, in plain words.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'navigate',
    description: 'Navigate the current tab to a URL, or go "back"/"forward" in history. Waits for the page to load.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL (https://…), or the literal string "back" or "forward".' },
      },
      required: ['url'],
    },
  },
  {
    name: 'read_page',
    description:
      'Read the current page as an indexed outline. Interactive elements get [refN] ids to use with click/type_text/select_option. Call this again after any navigation or page change — refs go stale.',
    input_schema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['interactive', 'all'],
          description: '"interactive" (default) lists only actionable elements; "all" also includes headings for context.',
        },
      },
    },
  },
  {
    name: 'get_page_text',
    description: 'Extract the readable text content of the current page (article/main content first). Use for reading, not for finding things to click.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'find',
    description:
      'Find elements on the page by describing them ("search box", "sign in button", "first video title"). Returns only the few best matches with their [refN] ids. PREFER THIS over read_page on big pages — it returns a handful of lines instead of the whole page.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for, in plain words.' },
        limit: { type: 'number', description: 'Max matches to return (default 6).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_section',
    description:
      'Read only the part of the page that talks about something ("price", "ingredients", "opening hours"). Returns a few short passages instead of the entire text. Use this instead of get_page_text when you know what you are after.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The topic or heading you want to read about.' },
        max_chars: { type: 'number', description: 'Maximum characters to return.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'extract_links',
    description: 'List the links on the page as "text → url", optionally filtered by a query. Compact — good for picking a search result or navigating a listing page.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Only return links matching this (optional).' },
        limit: { type: 'number', description: 'Max links (default 15).' },
      },
    },
  },
  {
    name: 'click',
    description: 'Click an element by its [refN] id from the latest read_page.',
    input_schema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'Element ref, e.g. "ref12".' } },
      required: ['ref'],
    },
  },
  {
    name: 'type_text',
    description: 'Type text into an input, textarea, or contenteditable element (replaces its current value). Refuses password fields.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from read_page.' },
        text: { type: 'string' },
        press_enter: { type: 'boolean', description: 'Press Enter after typing (submits most search boxes and forms).' },
      },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'select_option',
    description: 'Choose an option in a <select> dropdown by visible text or value.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        value: { type: 'string', description: 'Option text or value attribute.' },
      },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page (down/up/top/bottom), or scroll a specific ref into view.',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'] },
        amount: { type: 'number', description: 'Pixels to scroll (default: ~one viewport).' },
        ref: { type: 'string', description: 'If set, scrolls this element into view instead.' },
      },
    },
  },
  {
    name: 'press_key',
    description: 'Press a keyboard key on the focused element. Supported: Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, or a single character.',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'screenshot',
    description: 'Take a screenshot of the current tab. Use when the page layout matters or read_page is not enough (canvas apps, images, visual checks).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_tabs',
    description: 'List open tabs in the current window with their ids, titles, and URLs.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'open_tab',
    description: 'Open a new tab at a URL and make it the tab the agent acts on.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'switch_tab',
    description: 'Switch the agent to act on a different tab (id from list_tabs).',
    input_schema: {
      type: 'object',
      properties: { tab_id: { type: 'number' } },
      required: ['tab_id'],
    },
  },
  {
    name: 'close_tab',
    description: 'Close a tab by id.',
    input_schema: {
      type: 'object',
      properties: { tab_id: { type: 'number' } },
      required: ['tab_id'],
    },
  },
  {
    name: 'wait',
    description: 'Wait for the page to settle (dynamic content, redirects). Max 10 seconds.',
    input_schema: {
      type: 'object',
      properties: { seconds: { type: 'number', description: 'Default 2, max 10.' } },
    },
  },
];

const PAGE_TOOLS = new Set([
  'read_page', 'get_page_text', 'find', 'read_section', 'extract_links',
  'click', 'type_text', 'select_option', 'scroll', 'press_key',
]);

// Page tools whose output scales with page size, so it must be capped.
const BULKY_TOOLS = new Set(['read_page', 'get_page_text', 'read_section', 'extract_links']);

// Small on-device models degrade badly when given all 14 tools, so they get
// this core set — enough to browse, read, and fill in forms.
// Deliberately leads with the targeted lookups rather than read_page: a small
// model that reaches for read_page on a large site immediately runs out of room.
const CORE_TOOL_NAMES = new Set([
  'navigate', 'find', 'read_section', 'extract_links', 'click', 'type_text', 'scroll', 'read_page',
  'search_knowledge',
]);

export function toolsFor({ compact = false, hasKnowledge = false } = {}) {
  const base = compact ? TOOL_DEFINITIONS.filter((t) => CORE_TOOL_NAMES.has(t.name)) : TOOL_DEFINITIONS;
  // Offering a tool that can only ever return "empty" wastes a model call.
  return hasKnowledge ? base : base.filter((t) => t.name !== 'search_knowledge');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new Error('The tab the agent was working on no longer exists. Use list_tabs or open_tab.');
  }
}

function assertScriptable(tab) {
  if (RESTRICTED_URL.test(tab.url || '')) {
    throw new Error(`Cannot access ${tab.url} — Chrome blocks extensions on internal pages. Navigate to a normal website first.`);
  }
}

async function ensureContentScript(tabId) {
  const tab = await getTab(tabId);
  assertScriptable(tab);
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { __openAgent: true, name: 'ping' });
    if (pong?.ok) return;
  } catch {
    // not injected yet
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content-script.js'] });
}

async function callPageTool(tabId, name, input) {
  await ensureContentScript(tabId);
  const response = await chrome.tabs.sendMessage(tabId, { __openAgent: true, name, input });
  if (!response) throw new Error('No response from the page. It may have navigated — try read_page again.');
  if (!response.ok) throw new Error(response.error);
  return response.result;
}

// Resolves when the tab finishes loading, or after `timeoutMs` — navigation
// that outlives the timeout is not an error, the agent just proceeds.
function waitForLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') finish();
    }).catch(finish);
  });
}

async function describeTab(tabId) {
  const tab = await getTab(tabId);
  return `Now on: "${tab.title || ''}" — ${tab.url}`;
}

/**
 * Execute one tool call.
 * @param {string} name
 * @param {object} input
 * @param {{ tabId: number, setTabId: (id: number) => void }} ctx — the agent's current tab
 * @returns {Promise<{ text: string, imageDataUrl?: string }>}
 */
/** Clears the on-page activity overlay. Best-effort: never throws. */
export async function clearPageActivity(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { __openAgent: true, name: 'activity', input: { done: true } });
  } catch {
    // tab closed, navigated, or script not injected — nothing to clear
  }
}

/**
 * Decides whether to use trusted CDP input for the current tab, and attaches
 * on demand. Never throws — a false return means "use synthetic input".
 *   off  — never; on — always; auto — only on sites that ignore synthetic input.
 */
async function useTrusted(ctx) {
  const mode = ctx.cdpMode || 'off';
  if (mode === 'off') return false;

  let tab;
  try {
    tab = await getTab(ctx.tabId);
  } catch {
    return false;
  }
  assertScriptable(tab);
  if (mode === 'auto' && !cdp.siteNeedsTrusted(tab.url)) return false;

  const attached = await cdp.attach(ctx.tabId);
  if (attached && !ctx.trustedNotified) {
    ctx.trustedNotified = true;
    ctx.onTrusted?.(tab.url); // lets the UI note the debugging banner once
  }
  return attached;
}

async function trustedAction(name, input, ctx) {
  const tabId = ctx.tabId;

  if (name === 'press_key') {
    await cdp.trustedKey(tabId, input.key);
    return `Pressed ${input.key} (trusted input).`;
  }

  // click and type_text both need the element's on-screen position.
  const rect = await callPageTool(tabId, 'element_rect', {
    ref: input.ref,
    guardPassword: name === 'type_text',
  });

  if (name === 'click') {
    await cdp.trustedClick(tabId, rect.x, rect.y);
    return `Clicked (trusted input) "${rect.label || input.ref}".`;
  }

  // type_text: focus with a real click, clear, then insert as trusted text.
  await cdp.trustedClick(tabId, rect.x, rect.y);
  await sleep(60);
  await cdp.trustedClear(tabId);
  await cdp.trustedType(tabId, input.text);
  if (input.press_enter) {
    await sleep(50);
    await cdp.trustedKey(tabId, 'Enter');
  }
  return `Typed (trusted input) into "${rect.label || input.ref}"${input.press_enter ? ' and pressed Enter' : ''}.`;
}

export async function executeTool(name, input, ctx, { inBatch = false } = {}) {
  switch (name) {
    case 'batch': {
      if (inBatch) throw new Error('A batch cannot contain another batch.');
      const actions = Array.isArray(input.actions) ? input.actions.slice(0, 8) : [];
      if (!actions.length) throw new Error('batch needs a non-empty "actions" array.');

      const lines = [];
      let lastImage;
      let failed = false;

      for (const [index, action] of actions.entries()) {
        const step = `${index + 1}. ${action?.tool}`;
        try {
          const result = await executeTool(action.tool, action.input || {}, ctx, { inBatch: true });
          if (result.imageDataUrl) lastImage = result.imageDataUrl;
          lines.push(`${step}: ${result.text.slice(0, 700)}`);
        } catch (err) {
          // Stop rather than plough on: later actions almost always depend on
          // earlier ones, and stale refs would make their results meaningless.
          lines.push(`${step}: FAILED — ${err?.message || err}`);
          failed = true;
          if (index < actions.length - 1) {
            lines.push(`(stopped — ${actions.length - index - 1} remaining action(s) skipped)`);
          }
          break;
        }
      }

      const header = failed
        ? 'Batch stopped early. Re-check the page (find/read_page) before retrying the rest.'
        : `Batch completed all ${actions.length} actions.`;
      return { text: `${header}\n${lines.join('\n')}`, imageDataUrl: lastImage };
    }

    case 'navigate': {
      const url = String(input.url || '').trim();
      if (url === 'back' || url === 'forward') {
        await (url === 'back' ? chrome.tabs.goBack(ctx.tabId) : chrome.tabs.goForward(ctx.tabId)).catch(() => {
          throw new Error(`Cannot go ${url} — no history in that direction.`);
        });
      } else {
        if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http:// or https://');
        checkUrlAllowed(ctx.scope, url);
        await chrome.tabs.update(ctx.tabId, { url });
      }
      await waitForLoad(ctx.tabId);
      await sleep(400);
      return { text: `${await describeTab(ctx.tabId)}\nCall read_page to see the page.` };
    }

    case 'screenshot': {
      const tab = await getTab(ctx.tabId);
      // captureVisibleTab only sees the active tab, so focus is borrowed and
      // handed back — otherwise parallel agents would fight over the window.
      const [previouslyActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (!tab.active) {
        await chrome.tabs.update(ctx.tabId, { active: true });
        await sleep(350);
      }
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
        return { text: `Screenshot of ${tab.url}`, imageDataUrl: dataUrl };
      } finally {
        if (previouslyActive && previouslyActive.id !== ctx.tabId) {
          await chrome.tabs.update(previouslyActive.id, { active: true }).catch(() => {});
        }
      }
    }

    case 'list_tabs': {
      const all = await chrome.tabs.query({ currentWindow: true });
      // A scoped agent should not even see tabs it may not touch.
      const tabs = ctx.scope?.active ? all.filter((t) => ctx.scope.tabIds.has(t.id)) : all;
      const lines = tabs.map(
        (t) => `${t.id === ctx.tabId ? '→' : ' '} [${t.id}] "${(t.title || '').slice(0, 80)}" ${t.url}`
      );
      return { text: `Open tabs (→ = agent's current tab):\n${lines.join('\n')}` };
    }

    case 'open_tab': {
      if (!/^https?:\/\//i.test(input.url || '')) throw new Error('URL must start with http:// or https://');
      checkUrlAllowed(ctx.scope, input.url);
      const tab = await chrome.tabs.create({ url: input.url, active: false });
      admitTab(ctx.scope, tab.id);
      ctx.setTabId(tab.id);
      await ctx.onTabOpened(tab.id);
      await waitForLoad(tab.id);
      await sleep(400);
      return { text: `Opened tab [${tab.id}]. ${await describeTab(tab.id)}` };
    }

    case 'switch_tab': {
      checkTabAllowed(ctx.scope, input.tab_id);
      const tab = await getTab(input.tab_id);
      ctx.setTabId(tab.id);
      await chrome.tabs.update(tab.id, { active: true });
      return { text: await describeTab(tab.id) };
    }

    case 'close_tab': {
      if (input.tab_id === ctx.tabId) {
        throw new Error("Refusing to close the agent's current tab. switch_tab to another tab first.");
      }
      await chrome.tabs.remove(input.tab_id);
      return { text: `Closed tab [${input.tab_id}].` };
    }

    case 'search_knowledge':
      return { text: await searchKnowledge(input.query, { maxChars: ctx.limits?.pageChars || 4000 }) };

    case 'wait': {
      const seconds = Math.min(Math.max(input.seconds ?? 2, 0.5), 10);
      await sleep(seconds * 1000);
      return { text: `Waited ${seconds}s.` };
    }

    default: {
      if (!PAGE_TOOLS.has(name)) throw new Error(`Unknown tool: ${name}`);

      // Trusted-input path: click/type/press_key go through CDP on sites that
      // ignore synthetic events (Google Docs/Sheets, Notion, …). Falls back to
      // the synthetic path below whenever CDP is off or cannot attach.
      if (INPUT_TOOLS.has(name) && (await useTrusted(ctx))) {
        const out = await trustedAction(name, input, ctx);
        if (name === 'click' || (name === 'type_text' && input.press_enter)) {
          await sleep(600);
          await waitForLoad(ctx.tabId, 8000);
          return { text: `${out}\n${await describeTab(ctx.tabId)}` };
        }
        return { text: out };
      }

      const budget = ctx.limits?.pageChars;
      const payload = budget && BULKY_TOOLS.has(name)
        ? { ...input, max_chars: Math.min(Number(input.max_chars) || budget, budget) }
        : input;

      let result = await callPageTool(ctx.tabId, name, payload);

      // Last line of defence: never hand back more than the model can hold.
      if (budget && typeof result === 'string' && result.length > budget) {
        result =
          `${result.slice(0, budget)}\n…[truncated to fit the model's context. ` +
          'Use find("…") or read_section("…") to get just the part you need.]';
      }
      // Clicks often trigger navigation — give the page a moment, then report
      // where we ended up so the model knows to re-read.
      if (name === 'click' || (name === 'type_text' && input.press_enter)) {
        await sleep(600);
        await waitForLoad(ctx.tabId, 8000);
        return { text: `${result}\n${await describeTab(ctx.tabId)}` };
      }
      return { text: String(result) };
    }
  }
}
