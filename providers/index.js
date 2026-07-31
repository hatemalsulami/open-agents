// Provider registry. Every adapter implements:
//
//   chat({ system, messages, tools, signal }) -> Promise<{
//     text: string,                     // concatenated assistant text
//     toolCalls: [{ id, name, input }], // empty when the model is done
//     content: [block],                 // assistant content blocks (internal format)
//     usage?: { input, output },
//   }>
//
// Internal message format (Anthropic-style content blocks):
//   { role: 'user'|'assistant', content: [
//       { type: 'text', text }
//     | { type: 'image', dataUrl }                       // "data:image/jpeg;base64,…"
//     | { type: 'tool_use', id, name, input }
//     | { type: 'tool_result', tool_use_id, content: [text|image blocks], is_error? }
//   ]}
//
// Adapters convert this format to and from each provider's wire format.

import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { GeminiProvider } from './gemini.js';
import { LocalProvider, LOCAL_ENGINES } from './local.js';

export const PROVIDER_INFO = {
  builtin: {
    label: `⬤ ${LOCAL_ENGINES.builtin.label} — no key`,
    blurb: LOCAL_ENGINES.builtin.blurb,
    keyUrl: '',
    needsBaseUrl: false,
    needsKey: false,
    isLocal: true,
    fixedModel: 'gemini-nano',
  },
  webllm: {
    label: `⬤ ${LOCAL_ENGINES.webllm.label} — no key`,
    blurb: LOCAL_ENGINES.webllm.blurb,
    keyUrl: '',
    needsBaseUrl: false,
    needsKey: false,
    isLocal: true,
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyPrefix: 'sk-ant-',
    needsBaseUrl: false,
    needsKey: true,
  },
  gemini: {
    label: 'Google (Gemini)',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyPrefix: 'AIza',
    needsBaseUrl: false,
    needsKey: true,
  },
  openai: {
    label: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPrefix: 'sk-',
    needsBaseUrl: false,
    needsKey: true,
  },
  custom: {
    label: 'OpenAI-compatible (Ollama, OpenRouter, Groq…)',
    keyUrl: '',
    needsBaseUrl: true,
    needsKey: false,
  },
};

export const DEFAULT_CONFIG = {
  provider: 'anthropic',
  providers: {},
  maxSteps: 30,
  approvalMode: 'auto',
  customInstructions: '',
  keepScreenshots: 2,
  planMode: 'auto',
  language: 'auto',
  speakAnswers: false,
  voiceUri: '',
  voiceRate: 1,
  cdpMode: 'auto',
  streaming: true,
  budgetUsd: 0,
  currency: 'USD',
};

/**
 * Validates config and returns a ready provider instance.
 * Errors name the exact missing field so the UI can be specific.
 */
/**
 * Checks whether a config could run, without constructing anything.
 * @returns {string|null} the problem, or null when the config is usable
 */
export function configProblem(config) {
  const info = PROVIDER_INFO[config?.provider];
  if (!info) return `Unknown provider "${config?.provider}". Pick one in setup.`;

  const settings = config.providers?.[config.provider] || {};
  if (info.needsKey && !settings.apiKey) return `No API key set for ${info.label}. Add it in setup (⚙).`;
  if (info.needsBaseUrl && !settings.baseUrl) return 'Custom provider needs a base URL, e.g. http://localhost:11434/v1';
  if (!(info.fixedModel || settings.model)) return `No model selected for ${info.label}. Pick one in setup (⚙).`;
  return null;
}

export function isConfigured(config) {
  return configProblem(config) === null;
}

export function createProvider(config, { localBridge } = {}) {
  const problem = configProblem(config);
  if (problem) throw new Error(problem);

  const providerId = config.provider;
  const info = PROVIDER_INFO[providerId];
  const settings = config.providers?.[providerId] || {};
  const model = info.fixedModel || settings.model;

  if (info.isLocal) {
    if (!localBridge) throw new Error('On-device models are not reachable from this page.');
    return new LocalProvider({ engine: providerId, model, bridge: localBridge });
  }

  switch (providerId) {
    case 'anthropic':
      return new AnthropicProvider(settings);
    case 'gemini':
      return new GeminiProvider(settings);
    case 'openai':
      return new OpenAIProvider({ baseUrl: 'https://api.openai.com/v1', ...settings, providerId });
    case 'custom':
      return new OpenAIProvider({ ...settings, providerId });
    default:
      throw new Error(`Unknown provider: ${providerId}`);
  }
}

export function splitDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  if (!match) throw new Error('Invalid image data URL');
  return { mediaType: match[1], base64: match[2] };
}

export async function readErrorBody(response) {
  let detail = '';
  try {
    const body = await response.text();
    try {
      const json = JSON.parse(body);
      detail = json.error?.message || json.message || body;
    } catch {
      detail = body;
    }
  } catch {
    // ignore
  }
  return `${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 400)}` : ''}`;
}

/**
 * Turns a provider HTTP failure into an Error that says what to do next.
 * Raw upstream text is kept, but the actionable line comes first — most of
 * these failures are fixed by changing the model or the key, and the raw
 * message rarely says so.
 */
export async function apiError(providerId, response) {
  const raw = await readErrorBody(response);
  const label = PROVIDER_INFO[providerId]?.label || providerId;
  const lower = raw.toLowerCase();
  let advice = '';

  if (response.status === 404 || lower.includes('no longer available') || lower.includes('not found for api version')) {
    advice = 'That model is not available to your key. Open setup (⚙) and press ⟳ to load the models your key can actually use, then pick one.';
  } else if (response.status === 429) {
    advice = lower.includes('limit: 0')
      ? 'Your key has no free-tier quota for this model. Press ⟳ in setup and switch to a model your tier allows (for Gemini, "gemini-2.0-flash" is the safest free choice).'
      : 'Rate limit or quota reached. Wait a moment and retry, switch to a cheaper model, or check your billing.';
  } else if (response.status === 401 || response.status === 403) {
    advice = `Your ${label} API key was rejected. Check it in setup (⚙) — make sure it is a key for this provider and still active.`;
  } else if (response.status === 400 && lower.includes('image')) {
    advice = 'This model cannot accept screenshots. Pick a vision-capable model, or set "Screenshots kept in context" to 0 in Settings.';
  } else if (response.status >= 500) {
    advice = `${label} is having server trouble. This is on their side — retry shortly.`;
  }

  const err = new Error(advice ? `${advice}\n\n(${label}: ${raw})` : `${label} API error: ${raw}`);
  err.status = response.status;
  return err;
}
