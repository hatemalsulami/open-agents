// OpenAI Chat Completions adapter. Also covers any OpenAI-compatible endpoint
// (Ollama, OpenRouter, Groq, LM Studio, vLLM…) via a configurable base URL.

import { apiError } from './index.js';
import { sseEvents, parseJson } from './stream.js';

// The tool role only carries text, so images inside tool results are hoisted
// into a follow-up user message — the standard workaround for this API shape.
function toOpenAIMessages(system, messages) {
  const out = [{ role: 'system', content: system }];

  for (const message of messages) {
    if (message.role === 'assistant') {
      const textParts = [];
      const toolCalls = [];
      for (const block of message.content) {
        if (block.type === 'text') textParts.push(block.text);
        if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
          });
        }
      }
      const entry = { role: 'assistant', content: textParts.join('\n') || null };
      if (toolCalls.length) entry.tool_calls = toolCalls;
      out.push(entry);
      continue;
    }

    // user message: may mix plain content and tool results
    const plainParts = [];
    const imageParts = [];
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        let text = '';
        for (const inner of block.content) {
          if (inner.type === 'text') text += inner.text;
          if (inner.type === 'image') {
            imageParts.push({ type: 'image_url', image_url: { url: inner.dataUrl } });
            text += text ? '' : '(see attached screenshot)';
          }
        }
        out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: text || '(empty)' });
      } else if (block.type === 'text') {
        plainParts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        plainParts.push({ type: 'image_url', image_url: { url: block.dataUrl } });
      }
    }
    if (imageParts.length) {
      out.push({ role: 'user', content: [{ type: 'text', text: 'Screenshot from the tool above:' }, ...imageParts] });
    }
    if (plainParts.length) {
      out.push({ role: 'user', content: plainParts });
    }
  }
  return out;
}

export class OpenAIProvider {
  constructor({ apiKey, model, baseUrl, providerId = 'openai' }) {
    this.apiKey = apiKey || '';
    this.model = model;
    this.providerId = providerId;
    this.baseUrl = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  }

  async chat({ system, messages, tools, signal, onDelta }) {
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const body = {
      model: this.model,
      messages: toOpenAIMessages(system, messages),
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      })),
    };
    if (onDelta) {
      body.stream = true;
      // Without this, streamed responses carry no usage numbers at all.
      body.stream_options = { include_usage: true };
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await apiError(this.providerId, response);
    if (onDelta) return this.readStream(response, onDelta);

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) throw new Error('Provider returned no choices.');

    const content = [];
    const toolCalls = [];
    const text = choice.message?.content || '';
    if (text) content.push({ type: 'text', text });

    for (const call of choice.message?.tool_calls || []) {
      let input = {};
      try {
        input = JSON.parse(call.function.arguments || '{}');
      } catch {
        input = { __parse_error: call.function.arguments };
      }
      toolCalls.push({ id: call.id, name: call.function.name, input });
      content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
    }

    return {
      text,
      toolCalls,
      content,
      usage: data.usage ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens } : undefined,
    };
  }

  /**
   * Reassembles a streamed completion. Tool calls arrive as fragments keyed by
   * index, with the name in the first fragment and arguments split across many.
   */
  async readStream(response, onDelta) {
    const calls = new Map(); // index -> { id, name, args }
    let text = '';
    let usage;

    for await (const payload of sseEvents(response)) {
      const event = parseJson(payload);
      if (!event) continue;
      if (event.usage) usage = { input: event.usage.prompt_tokens, output: event.usage.completion_tokens };

      const delta = event.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        text += delta.content;
        onDelta(delta.content);
      }

      for (const fragment of delta.tool_calls || []) {
        const index = fragment.index ?? 0;
        const call = calls.get(index) || { id: '', name: '', args: '' };
        if (fragment.id) call.id = fragment.id;
        if (fragment.function?.name) call.name += fragment.function.name;
        if (fragment.function?.arguments) call.args += fragment.function.arguments;
        calls.set(index, call);
      }
    }

    const content = [];
    const toolCalls = [];
    if (text) content.push({ type: 'text', text });

    for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      let input = {};
      try {
        input = call.args ? JSON.parse(call.args) : {};
      } catch {
        input = { __parse_error: call.args };
      }
      // Some OpenAI-compatible servers omit ids when streaming.
      const id = call.id || `call_${index}_${text.length}`;
      toolCalls.push({ id, name: call.name, input });
      content.push({ type: 'tool_use', id, name: call.name, input });
    }

    return { text, toolCalls, content, usage };
  }
}
