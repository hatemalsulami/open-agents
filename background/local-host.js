// Service-worker side bridge to the offscreen inference host: creates the
// offscreen document on demand and forwards requests to it.

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

let creating = null;

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    return contexts.length > 0;
  }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreenDocument()) return;
  if (creating) return creating;

  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS'],
      justification: 'Runs on-device language models (WebGPU / Chrome built-in AI), which are unavailable in a service worker.',
    })
    .catch((err) => {
      // A concurrent create wins the race; that is fine.
      if (!/single offscreen|already exists/i.test(err?.message || '')) throw err;
    })
    .finally(() => {
      creating = null;
    });

  return creating;
}

/** Bridge object handed to LocalProvider. */
export const localBridge = {
  async request(payload) {
    await ensureOffscreen();
    const response = await chrome.runtime.sendMessage({
      ...payload,
      signal: undefined, // AbortSignal cannot cross the message boundary
      __openAgentLocal: true,
      target: 'offscreen', // set last: never let a forwarded payload override it
    });
    if (!response) throw new Error('The local model host did not respond. Try reloading the extension.');
    if (!response.ok) throw new Error(response.error);
    return response.result;
  },
};

export async function localAvailability(engine) {
  return localBridge.request({ type: 'availability', engine });
}

export async function localModels(engine) {
  return localBridge.request({ type: 'list_models', engine });
}
