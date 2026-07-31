// Anthropic Messages API adapter. The internal message format is already
// Anthropic-shaped, so conversion is mostly passing through and mapping images.

import { splitDataUrl, apiError } from './index.js';
import { sseEvents, parseJson } from './stream.js';

const API_URL = 'https://api.anthropic.com/v1/messages';

function toAnthropicBlocks(blocks) {
  return blocks.map((block) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'image': {
        const { mediaType, base64 } = splitDataUrl(block.dataUrl);
        return { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };
      }
      case 'tool_use':
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          is_error: block.is_error || false,
          content: toAnthropicBlocks(block.content),
        };
      default:
        throw new Error(`Unknown block type: ${block.type}`);
    }
  });
}

export class AnthropicProvider {
  constructor({ apiKey, model }) {
    if (!apiKey) throw new Error('Anthropic API key is not set. Open OpenAgent settings.');
    this.apiKey = apiKey;
    this.model = model;
  }

  async chat({ system, messages, tools, signal, onDelta }) {
    const body = {
      model: this.model,
      max_tokens: 4096,
      system,
      messages: messages.map((m) => ({ role: m.role, content: toAnthropicBlocks(m.content) })),
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    };
    if (onDelta) body.stream = true;

    const response = await fetch(API_URL, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        // Required for direct calls from a browser extension context.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await apiError('anthropic', response);
    if (onDelta) return this.readStream(response, onDelta);

    const data = await response.json();
    const content = [];
    const toolCalls = [];
    let text = '';

    for (const block of data.content || []) {
      if (block.type === 'text') {
        text += block.text;
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, input: block.input || {} });
        content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input || {} });
      }
    }

    return {
      text,
      toolCalls,
      content,
      usage: data.usage ? { input: data.usage.input_tokens, output: data.usage.output_tokens } : undefined,
    };
  }

  /**
   * Reassembles a streamed response. Anthropic streams tool arguments as a
   * sequence of partial JSON strings, so those are buffered per block index
   * and parsed once the block closes.
   */
  async readStream(response, onDelta) {
    const blocks = new Map(); // index -> { type, text?, id?, name?, json? }
    const usage = { input: 0, output: 0 };
    let text = '';

    for await (const payload of sseEvents(response)) {
      const event = parseJson(payload);
      if (!event) continue;

      switch (event.type) {
        case 'message_start':
          usage.input = event.message?.usage?.input_tokens || 0;
          break;

        case 'content_block_start': {
          const block = event.content_block;
          blocks.set(event.index, block.type === 'tool_use'
            ? { type: 'tool_use', id: block.id, name: block.name, json: '' }
            : { type: 'text', text: '' });
          break;
        }

        case 'content_block_delta': {
          const block = blocks.get(event.index);
          if (!block) break;
          if (event.delta?.type === 'text_delta') {
            block.text += event.delta.text;
            text += event.delta.text;
            onDelta(event.delta.text);
          } else if (event.delta?.type === 'input_json_delta') {
            block.json += event.delta.partial_json || '';
          }
          break;
        }

        case 'message_delta':
          if (event.usage?.output_tokens) usage.output = event.usage.output_tokens;
          break;

        case 'error':
          throw new Error(event.error?.message || 'Anthropic stream error');
      }
    }

    const content = [];
    const toolCalls = [];
    for (const block of [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b)) {
      if (block.type === 'text') {
        if (block.text) content.push({ type: 'text', text: block.text });
      } else {
        let input = {};
        try {
          input = block.json ? JSON.parse(block.json) : {};
        } catch {
          input = {};
        }
        toolCalls.push({ id: block.id, name: block.name, input });
        content.push({ type: 'tool_use', id: block.id, name: block.name, input });
      }
    }

    return { text, toolCalls, content, usage };
  }
}
