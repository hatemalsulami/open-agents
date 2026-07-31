// Local inference host. Runs entirely on the user's machine — no API key and,
// once a model is downloaded, no network at all.
//
// Two engines:
//   builtin — Chrome's built-in Gemini Nano via the Prompt API. Nothing to
//             install; Chrome manages the weights. Supports JSON schema
//             constraints, which makes tool calling reliable.
//   webllm  — genuinely open-source models (Qwen, Llama, Phi, Gemma) compiled
//             to WebGPU by MLC. Needs vendor/web-llm.js (scripts/fetch-vendor.sh)
//             and a one-time weights download.

const VENDOR_URL = '../vendor/web-llm.js';

const engines = {
  builtin: { session: null, model: null },
  webllm: { engine: null, model: null, lib: null },
};

function report(progress) {
  chrome.runtime.sendMessage({ __openAgentLocal: true, type: 'progress', progress }).catch(() => {});
}

// ------------------------------------------------------------------ built-in

// The Prompt API has been exposed as `LanguageModel` and, in older builds, as
// `self.ai.languageModel`. Both are accepted so the extension works across
// Chrome versions without a flag dance.
function builtinApi() {
  if (typeof LanguageModel !== 'undefined') return LanguageModel;
  if (self.ai?.languageModel) return self.ai.languageModel;
  return null;
}

async function builtinAvailability() {
  const api = builtinApi();
  if (!api) {
    return {
      state: 'unavailable',
      detail:
        'This Chrome build has no built-in AI. It needs Chrome 138+ on desktop with ~22 GB free disk and 4 GB+ VRAM. Try chrome://flags/#prompt-api-for-gemini-nano, or use WebLLM instead.',
    };
  }
  try {
    // Newer builds return a string; older ones return { available }.
    const raw = api.availability ? await api.availability() : (await api.capabilities())?.available;
    const state = String(raw);
    if (state === 'available' || state === 'readily') return { state: 'ready', detail: 'Gemini Nano is ready.' };
    if (state === 'downloadable' || state === 'after-download') {
      return { state: 'downloadable', detail: 'Gemini Nano needs a one-time download (~2 GB). It starts on first use.' };
    }
    if (state === 'downloading') return { state: 'downloading', detail: 'Gemini Nano is downloading…' };
    return { state: 'unavailable', detail: `Built-in AI reported "${state}" on this device.` };
  } catch (err) {
    return { state: 'unavailable', detail: err?.message || String(err) };
  }
}

async function builtinChat({ system, messages, schema, signal }) {
  const api = builtinApi();
  if (!api) throw new Error((await builtinAvailability()).detail);

  // Sessions are stateless here: the agent owns history, so each turn is a
  // fresh session seeded with the system prompt. That also prevents the small
  // context window from filling up with stale turns.
  const session = await api.create({
    initialPrompts: [{ role: 'system', content: system }],
    monitor: (monitor) => {
      monitor.addEventListener('downloadprogress', (event) => {
        report({ engine: 'builtin', loaded: event.loaded, total: event.total || 1, text: 'Downloading Gemini Nano…' });
      });
    },
  });

  try {
    const transcript = messages
      .map((m) => `${m.role === 'assistant' ? 'ASSISTANT' : 'USER'}: ${m.content}`)
      .join('\n\n');
    const options = { signal };
    if (schema) options.responseConstraint = schema;
    const text = await session.prompt(transcript, options);
    return { text };
  } finally {
    session.destroy?.();
  }
}

// -------------------------------------------------------------------- webllm

async function loadWebLlmLib() {
  if (engines.webllm.lib) return engines.webllm.lib;
  try {
    engines.webllm.lib = await import(VENDOR_URL);
  } catch (err) {
    throw new Error(
      'WebLLM library not found. Run scripts/fetch-vendor.sh once to download vendor/web-llm.js (6 MB), then reload the extension.'
    );
  }
  return engines.webllm.lib;
}

async function webllmAvailability() {
  if (!navigator.gpu) {
    return { state: 'unavailable', detail: 'This browser has no WebGPU. Local open-source models need Chrome 113+ with hardware acceleration on.' };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { state: 'unavailable', detail: 'WebGPU found no GPU adapter. Enable hardware acceleration in Chrome settings.' };
  } catch (err) {
    return { state: 'unavailable', detail: err?.message || 'WebGPU adapter request failed.' };
  }
  try {
    await loadWebLlmLib();
  } catch (err) {
    return { state: 'unavailable', detail: err.message };
  }
  return { state: 'downloadable', detail: 'WebGPU is ready. The model downloads once on first use, then runs fully offline.' };
}

async function ensureWebLlmEngine(model) {
  if (engines.webllm.engine && engines.webllm.model === model) return engines.webllm.engine;

  const lib = await loadWebLlmLib();
  if (engines.webllm.engine) {
    await engines.webllm.engine.unload?.().catch?.(() => {});
    engines.webllm.engine = null;
  }

  engines.webllm.engine = await lib.CreateMLCEngine(model, {
    initProgressCallback: (info) => {
      report({
        engine: 'webllm',
        loaded: info.progress ?? 0,
        total: 1,
        text: info.text || 'Loading model…',
      });
    },
  });
  engines.webllm.model = model;
  return engines.webllm.engine;
}

async function webllmChat({ system, messages, model }) {
  const engine = await ensureWebLlmEngine(model);
  const completion = await engine.chat.completions.create({
    messages: [{ role: 'system', content: system }, ...messages],
    temperature: 0.2,
    max_tokens: 800,
  });
  const choice = completion.choices?.[0];
  return {
    text: choice?.message?.content || '',
    usage: completion.usage
      ? { input: completion.usage.prompt_tokens, output: completion.usage.completion_tokens }
      : undefined,
  };
}

async function listWebLlmModels() {
  const lib = await loadWebLlmLib();
  return (lib.prebuiltAppConfig?.model_list || []).map((m) => ({
    id: m.model_id,
    label: m.vram_required_MB ? `${m.model_id} (~${Math.round(m.vram_required_MB / 1024)} GB VRAM)` : m.model_id,
  }));
}

// ------------------------------------------------------------------- routing

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.__openAgentLocal !== true || msg.target !== 'offscreen') return false;

  (async () => {
    try {
      switch (msg.type) {
        case 'availability':
          sendResponse({ ok: true, result: msg.engine === 'builtin' ? await builtinAvailability() : await webllmAvailability() });
          break;
        case 'list_models':
          sendResponse({ ok: true, result: msg.engine === 'webllm' ? await listWebLlmModels() : [{ id: 'gemini-nano', label: 'Gemini Nano (built into Chrome)' }] });
          break;
        case 'chat':
          sendResponse({
            ok: true,
            result: msg.engine === 'builtin'
              ? await builtinChat({ system: msg.system, messages: msg.messages, schema: msg.schema })
              : await webllmChat({ system: msg.system, messages: msg.messages, model: msg.model }),
          });
          break;
        default:
          sendResponse({ ok: false, error: `Unknown local request: ${msg.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true; // async response
});
