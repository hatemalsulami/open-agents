// Known-good model ids per provider, plus live model listing so the picker can
// refresh from the provider itself (every supported API exposes a list endpoint).
// The curated lists are a starting point — any id can still be typed by hand.

export const MODEL_CATALOG = {
  // On-device. Sizes are the one-time download; after that they run offline.
  builtin: [{ id: 'gemini-nano', label: 'Gemini Nano — built into Chrome', recommended: true }],
  webllm: [
    { id: 'Qwen3-1.7B-q4f16_1-MLC', label: 'Qwen3 1.7B — smallest, fastest (~1.5 GB)', recommended: true },
    { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B — better reasoning (~2.5 GB)' },
    { id: 'Phi-3.5-mini-instruct-q4f16_1-MLC', label: 'Phi 3.5 mini — strong for its size (~3 GB)' },
    { id: 'gemma-2-2b-it-q4f16_1-MLC', label: 'Gemma 2 2B (~2 GB)' },
    { id: 'Qwen3-8B-q4f16_1-MLC', label: 'Qwen3 8B — most capable, needs a big GPU (~6 GB)' },
  ],
  anthropic: [
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — best balance for agents', recommended: true },
    { id: 'claude-opus-5', label: 'Claude Opus 5 — most capable, pricier' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 — fastest, cheapest' },
  ],
  // Google moves availability around per key and tier, so treat this list as a
  // starting point only — press ⟳ to load what your key can actually call.
  gemini: [
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash — works on the free tier', recommended: true },
    { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite — cheapest' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash — newer keys may not have access' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro — paid tier only' },
  ],
  openai: [
    { id: 'gpt-4o', label: 'GPT-4o — vision + tools', recommended: true },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini — cheapest' },
    { id: 'gpt-4.1', label: 'GPT-4.1' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
  ],
  custom: [
    { id: 'qwen3', label: 'qwen3 (Ollama)' },
    { id: 'llama3.2-vision', label: 'llama3.2-vision (Ollama, sees screenshots)' },
    { id: 'anthropic/claude-sonnet-5', label: 'anthropic/claude-sonnet-5 (OpenRouter)' },
  ],
};

// Models that cannot see screenshots. The agent warns rather than blocking,
// since it can still work from read_page alone.
const TEXT_ONLY_HINTS = [/qwen(?!.*v)/i, /llama3(\.\d)?(?!.*vision)/i, /mistral/i, /deepseek/i, /gemma/i];

export function isLikelyTextOnly(modelId = '') {
  return TEXT_ONLY_HINTS.some((re) => re.test(modelId));
}

export function recommendedModel(providerId) {
  const list = MODEL_CATALOG[providerId] || [];
  return (list.find((m) => m.recommended) || list[0])?.id || '';
}

/**
 * Fetch the live model list from a provider.
 * @returns {Promise<{id: string, label: string}[]>}
 */
export async function listModels(providerId, settings = {}, { localBridge } = {}) {
  const { apiKey, baseUrl } = settings;

  if (providerId === 'builtin' || providerId === 'webllm') {
    if (!localBridge) throw new Error('On-device models are not reachable from this page.');
    return localBridge.request({ type: 'list_models', engine: providerId });
  }

  if (providerId === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    });
    if (!res.ok) throw new Error(await describeFailure(res));
    const data = await res.json();
    return (data.data || []).map((m) => ({ id: m.id, label: m.display_name || m.id }));
  }

  if (providerId === 'gemini') {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': apiKey },
    });
    if (!res.ok) throw new Error(await describeFailure(res));
    const data = await res.json();
    return (data.models || [])
      // Only models that can actually run the agent loop.
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }));
  }

  // OpenAI and any OpenAI-compatible endpoint
  const root = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const headers = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${root}/models`, { headers });
  if (!res.ok) throw new Error(await describeFailure(res));
  const data = await res.json();
  return (data.data || data.models || []).map((m) => ({ id: m.id || m.name, label: m.id || m.name }));
}

async function describeFailure(res) {
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    /* ignore */
  }
  return `Could not list models: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`;
}
