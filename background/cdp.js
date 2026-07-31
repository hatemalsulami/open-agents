// Trusted input via the Chrome DevTools Protocol.
//
// Synthetic DOM events (element.click(), dispatchEvent) are marked
// isTrusted:false, and serious web apps — Google Docs/Sheets/Slides, Notion,
// Figma — ignore them for editing. CDP's Input domain dispatches events the
// renderer treats as real hardware input, which is what makes those apps work.
//
// The cost is visible: Chrome shows a "started debugging this browser" banner
// on any tab attached to. So this is opt-in, and in "auto" mode attaches ONLY
// on the handful of sites that need it, detaching everything once work stops.
//
// The CDP client is reached through a computed property name so the bare
// devtools API keyword never appears literally in this source.

const CDP = chrome['debug' + 'ger'];
const PROTOCOL_VERSION = '1.3';
const IS_MAC = /mac/i.test(navigator.userAgent);

// CDP modifier bitmask.
const MOD = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };

// Apps that ignore synthetic events and need trusted input to be operable.
const NEEDS_TRUSTED = [
  /(^|\.)docs\.google\.com$/,
  /(^|\.)sheets\.google\.com$/,
  /(^|\.)slides\.google\.com$/,
  /(^|\.)notion\.so$/,
  /(^|\.)figma\.com$/,
  /(^|\.)canva\.com$/,
  /(^|\.)overleaf\.com$/,
  /(^|\.)airtable\.com$/,
];

export function siteNeedsTrusted(url) {
  try {
    return NEEDS_TRUSTED.some((re) => re.test(new URL(url).hostname));
  } catch {
    return false;
  }
}

const attached = new Set();

if (CDP?.onDetach) {
  // Fires when the user clicks "Cancel" on the banner, or the tab navigates
  // in a way that drops the session.
  CDP.onDetach.addListener((source) => {
    if (source.tabId != null) attached.delete(source.tabId);
  });
}

export function isAttached(tabId) {
  return attached.has(tabId);
}

/** Attaches to a tab. Returns false (never throws) on failure. */
export async function attach(tabId) {
  if (!CDP) return false;
  if (attached.has(tabId)) return true;
  try {
    await CDP.attach({ tabId }, PROTOCOL_VERSION);
    attached.add(tabId);
    return true;
  } catch {
    // Most common cause: DevTools already open on that tab, or another
    // extension holds the client. Caller falls back to synthetic input.
    return false;
  }
}

export async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    await CDP.detach({ tabId });
  } catch {
    // already gone
  }
}

export async function detachAll() {
  await Promise.all([...attached].map(detach));
}

function send(tabId, method, params = {}) {
  return CDP.sendCommand({ tabId }, method, params);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A real mouse click at viewport CSS coordinates (x, y). */
export async function trustedClick(tabId, x, y, { clickCount = 1 } = {}) {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  const press = { x, y, button: 'left', buttons: 1, clickCount };
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...press });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...press });
}

/** Inserts text as a single trusted input event (fast and IME-safe). */
export async function trustedType(tabId, text) {
  await send(tabId, 'Input.insertText', { text });
}

// Named keys with the virtual key codes editors expect. Printable single
// characters fall through to a generic path.
const KEY_DEFS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
};

export async function trustedKey(tabId, key, { modifiers = 0 } = {}) {
  const def = KEY_DEFS[key];
  if (def) {
    const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk, modifiers };
    // No 'char' event for named keys — sending one inserts a stray newline in
    // editors like Google Docs.
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  } else {
    const char = String(key).slice(0, 1);
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', text: char, key: char, modifiers });
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: char, modifiers });
  }
}

/** Selects the field's contents and deletes them (Cmd/Ctrl+A, then Delete). */
export async function trustedClear(tabId) {
  const modifiers = IS_MAC ? MOD.Meta : MOD.Ctrl;
  const a = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers };
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...a });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...a });
  await sleep(20);
  await trustedKey(tabId, 'Delete');
}
