// Google Gemini adapter (Generative Language API, v1beta).
// Gemini has no tool-call ids, so synthetic ids pair tool_use with tool_result,
// and its schema dialect rejects some JSON Schema keywords, which are stripped.

import { splitDataUrl, apiError } from './index.js';
import { sseEvents, parseJson } from './stream.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const UNSUPPORTED_SCHEMA_KEYS = new Set(['additionalProperties', '$schema', 'default', 'examples']);

function sanitizeSchema(schema) {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (schema && typeof schema === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(schema)) {
      if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
      out[key] = sanitizeSchema(value);
    }
    return out;
  }
  return schema;
}

function toGeminiContents(messages) {
  const contents = [];
  // Maps synthetic tool_use ids back to function names for functionResponse pairing.
  const toolNameById = new Map();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') toolNameById.set(block.id, block.name);
    }
  }

  for (const message of messages) {
    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          parts.push({
            text: block.text,
            ...(block.geminiThoughtSignature ? { thoughtSignature: block.geminiThoughtSignature } : {}),
          });
          break;
        case 'image': {
          const { mediaType, base64 } = splitDataUrl(block.dataUrl);
          parts.push({ inlineData: { mimeType: mediaType, data: base64 } });
          break;
        }
        case 'tool_use':
          // Gemini 2.5+ requires the thought signature it issued to be echoed
          // back with the function call, or the next turn fails with a 400.
          parts.push({
            functionCall: { name: block.name, args: block.input || {} },
            ...(block.geminiThoughtSignature ? { thoughtSignature: block.geminiThoughtSignature } : {}),
          });
          break;
        case 'tool_result': {
          const name = toolNameById.get(block.tool_use_id) || 'unknown_tool';
          let text = '';
          const images = [];
          for (const inner of block.content) {
            if (inner.type === 'text') text += inner.text;
            if (inner.type === 'image') {
              const { mediaType, base64 } = splitDataUrl(inner.dataUrl);
              images.push({ inlineData: { mimeType: mediaType, data: base64 } });
            }
          }
          parts.push({
            functionResponse: {
              name,
              response: block.is_error ? { error: text } : { result: text || 'ok' },
            },
          });
          parts.push(...images);
          break;
        }
      }
    }
    if (parts.length) contents.push({ role, parts });
  }
  return contents;
}

export class GeminiProvider {
  constructor({ apiKey, model }) {
    if (!apiKey) throw new Error('Gemini API key is not set. Open OpenAgent settings.');
    this.apiKey = apiKey;
    this.model = model;
    this.callCounter = 0;
  }

  async chat({ system, messages, tools, signal, onDelta }) {
    // Gemini uses a different method for streaming, and needs alt=sse to emit
    // real SSE rather than a JSON array.
    const method = onDelta ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const url = `${API_BASE}/${encodeURIComponent(this.model)}:${method}`;
    const response = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: toGeminiContents(messages),
        tools: [
          {
            functionDeclarations: tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: sanitizeSchema(t.input_schema),
            })),
          },
        ],
      }),
    });
    if (!response.ok) throw await apiError('gemini', response);
    if (onDelta) return this.readStream(response, onDelta);

    const data = await response.json();
    const candidate = data.candidates?.[0];
    if (!candidate) {
      const reason = data.promptFeedback?.blockReason;
      throw new Error(reason ? `Gemini blocked the request: ${reason}` : 'Gemini returned no candidates.');
    }

    const content = [];
    const toolCalls = [];
    let text = '';

    for (const part of candidate.content?.parts || []) {
      if (part.text) {
        text += part.text;
        content.push({
          type: 'text',
          text: part.text,
          geminiThoughtSignature: part.thoughtSignature || part.thought_signature,
        });
      } else if (part.functionCall) {
        const id = `gemini_call_${++this.callCounter}`;
        const input = part.functionCall.args || {};
        toolCalls.push({ id, name: part.functionCall.name, input });
        content.push({
          type: 'tool_use',
          id,
          name: part.functionCall.name,
          input,
          // Carried through history so it can be replayed on the next turn.
          geminiThoughtSignature: part.thoughtSignature || part.thought_signature,
        });
      }
    }

    return {
      text,
      toolCalls,
      content,
      usage: data.usageMetadata
        ? { input: data.usageMetadata.promptTokenCount, output: data.usageMetadata.candidatesTokenCount }
        : undefined,
    };
  }

  /**
   * Reassembles a streamed response. Gemini sends whole parts per chunk rather
   * than character deltas, and thought signatures must still be preserved.
   */
  async readStream(response, onDelta) {
    const content = [];
    const toolCalls = [];
    let text = '';
    let usage;

    for await (const payload of sseEvents(response)) {
      const event = parseJson(payload);
      if (!event) continue;

      if (event.usageMetadata) {
        usage = {
          input: event.usageMetadata.promptTokenCount,
          output: event.usageMetadata.candidatesTokenCount,
        };
      }

      for (const part of event.candidates?.[0]?.content?.parts || []) {
        if (part.text) {
          text += part.text;
          onDelta(part.text);
          content.push({
            type: 'text',
            text: part.text,
            geminiThoughtSignature: part.thoughtSignature || part.thought_signature,
          });
        } else if (part.functionCall) {
          const id = `gemini_call_${++this.callCounter}`;
          const input = part.functionCall.args || {};
          toolCalls.push({ id, name: part.functionCall.name, input });
          content.push({
            type: 'tool_use',
            id,
            name: part.functionCall.name,
            input,
            geminiThoughtSignature: part.thoughtSignature || part.thought_signature,
          });
        }
      }
    }

    return { text, toolCalls, content, usage };
  }
}
