// Model pricing, so the UI can show money instead of raw token counts and the
// agent can be stopped at a spend limit.
//
// Rates are USD per MILLION tokens, published list prices. They change, and a
// user's negotiated or free-tier rate may differ, so everything here is an
// ESTIMATE and the UI says so. Unknown models fall back to a mid-range guess
// rather than reporting zero, because a silent $0.00 is worse than "about".

const USD_PER_SAR = 3.75; // SAR is pegged to USD

/** [inputPerMillion, outputPerMillion] */
const RATES = {
  // Anthropic
  'claude-opus-5': [15, 75],
  'claude-sonnet-5': [3, 15],
  'claude-haiku-4-5': [1, 5],
  'claude-3-5-haiku': [0.8, 4],
  // Google
  'gemini-2.5-pro': [1.25, 10],
  'gemini-2.5-flash': [0.3, 2.5],
  'gemini-2.0-flash': [0.1, 0.4],
  'gemini-2.0-flash-lite': [0.075, 0.3],
  // OpenAI
  'gpt-4o': [2.5, 10],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4.1': [2, 8],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4.1-nano': [0.1, 0.4],
};

const FALLBACK = [1, 5];

/**
 * Looks up a model's rate by longest-prefix match, so dated or suffixed ids
 * ("claude-haiku-4-5-20251001", "gpt-4o-2024-11-20") resolve correctly.
 */
export function rateFor(providerId, modelId = '') {
  // On-device models cost nothing but electricity.
  if (providerId === 'builtin' || providerId === 'webllm') return { input: 0, output: 0, local: true };

  const id = String(modelId).toLowerCase();
  let best = null;
  for (const [key, rate] of Object.entries(RATES)) {
    if (id.includes(key) && (!best || key.length > best.key.length)) best = { key, rate };
  }

  // A custom endpoint is usually a local server (Ollama) — free unless it is a
  // known hosted model reached through a proxy such as OpenRouter.
  if (!best && providerId === 'custom') return { input: 0, output: 0, local: true, unknown: true };

  const [input, output] = best ? best.rate : FALLBACK;
  return { input, output, unknown: !best };
}

/** @returns {number} estimated USD for a usage total. */
export function estimateUsd(usage, rate) {
  if (!usage || !rate) return 0;
  return ((usage.input || 0) * rate.input + (usage.output || 0) * rate.output) / 1_000_000;
}

export function usdToSar(usd) {
  return usd * USD_PER_SAR;
}

/**
 * Formats a cost for display. Small amounts need more decimals to be useful at
 * all — "$0.00" tells the user nothing about a $0.004 run.
 */
export function formatCost(usd, currency = 'USD') {
  const value = currency === 'SAR' ? usdToSar(usd) : usd;
  const symbol = currency === 'SAR' ? 'SAR ' : '$';
  if (value === 0) return `${symbol}0`;
  if (value < 0.01) return `${symbol}${value.toFixed(4)}`;
  if (value < 1) return `${symbol}${value.toFixed(3)}`;
  return `${symbol}${value.toFixed(2)}`;
}

export const CURRENCIES = ['USD', 'SAR'];
