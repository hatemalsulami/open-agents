// Adapter for on-device models (Chrome built-in Gemini Nano, or open-source
// models via WebLLM/WebGPU). Inference happens in the offscreen document; this
// class only translates between the agent's message format and that host, and
// implements tool calling through the JSON protocol in json-tools.js.

import {
  buildProtocolPrompt, flattenMessages, collectToolNames, parseTurn, turnSchema,
} from './json-tools.js';

/**
 * Bridges to the offscreen document. Injected so the same adapter can run from
 * the service worker (real bridge) or a test harness (fake bridge).
 */
export class LocalProvider {
  constructor({ engine, model, bridge }) {
    this.engine = engine; // 'builtin' | 'webllm'
    this.model = model;
    this.bridge = bridge;
    // Small models handle a short tool list far better than the full 17.
    this.preferCompactTools = true;
    // Gemini Nano and small WebLLM models have a few-thousand-token window, so
    // page reads are capped hard and history is trimmed aggressively.
    this.pageCharBudget = engine === 'builtin' ? 1500 : 3000;
    this.historyTurns = 6;
    this.flattensHistory = true;
  }

  async chat({ system, messages, tools, signal }) {
    const prompt = tools.length ? buildProtocolPrompt(system, tools) : system;
    const flat = flattenMessages(messages, { toolNameById: collectToolNames(messages) });

    const { text, usage } = await this.bridge.request({
      type: 'chat',
      engine: this.engine,
      model: this.model,
      system: prompt,
      messages: flat,
      // Chrome's Prompt API can hard-constrain the reply shape; WebLLM relies
      // on the instructions plus tolerant parsing.
      schema: this.engine === 'builtin' && tools.length ? turnSchema(tools) : undefined,
      signal,
    });

    if (!tools.length) {
      return { text, toolCalls: [], content: [{ type: 'text', text }], usage };
    }
    return { ...parseTurn(text, tools), usage };
  }
}

export const LOCAL_ENGINES = {
  builtin: {
    label: 'Chrome built-in AI (Gemini Nano)',
    blurb: 'Runs inside Chrome. No API key, no account, no cost — and works offline once Chrome has downloaded the model.',
  },
  webllm: {
    label: 'Local open-source model (WebLLM + WebGPU)',
    blurb: 'Runs open-source models (Qwen, Llama, Phi, Gemma) on your GPU. Fully offline after a one-time model download.',
  },
};
