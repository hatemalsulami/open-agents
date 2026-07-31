// Tool calling for models with no native tool-call API.
//
// Chrome's built-in Gemini Nano and the small open models WebLLM runs cannot
// emit `tool_use` blocks, so they are asked for one strict JSON object per turn
// instead. Chrome's Prompt API can enforce the shape with a JSON schema; WebLLM
// gets the same contract by instruction plus tolerant parsing.

/** JSON schema for a single agent turn, used as Chrome's responseConstraint. */
export function turnSchema(tools) {
  return {
    type: 'object',
    properties: {
      thought: { type: 'string', description: 'One short sentence about what to do next.' },
      tool: {
        type: 'string',
        description: 'Name of the tool to use, or "none" when answering the user.',
        enum: [...tools.map((t) => t.name), 'none'],
      },
      input: { type: 'object', description: 'Arguments for the tool. {} when tool is "none".' },
      answer: { type: 'string', description: 'Final answer for the user. Only when tool is "none".' },
    },
    required: ['thought', 'tool'],
  };
}

function describeSchema(schema) {
  const props = schema?.properties || {};
  const required = new Set(schema?.required || []);
  const parts = Object.entries(props).map(([name, spec]) => {
    const type = spec.enum ? spec.enum.map((v) => `"${v}"`).join('|') : spec.type;
    return `${name}${required.has(name) ? '' : '?'}: ${type}`;
  });
  return parts.join(', ') || 'no arguments';
}

/** Compact tool reference injected into the system prompt. */
export function renderToolSpec(tools) {
  return tools
    .map((t) => `- ${t.name}(${describeSchema(t.input_schema)})\n    ${t.description.split('\n')[0]}`)
    .join('\n');
}

export function buildProtocolPrompt(system, tools) {
  return `${system}

────────────────────────
TOOLS YOU CAN USE
${renderToolSpec(tools)}

RESPONSE FORMAT — THIS IS MANDATORY
Reply with ONE JSON object and nothing else. No prose before or after, no markdown fences.

To use a tool:
{"thought":"why this step","tool":"read_page","input":{}}

To finish and answer the user:
{"thought":"I have what I need","tool":"none","answer":"your full answer here"}

Rules:
- Exactly one JSON object per reply. One tool at a time.
- "input" must match that tool's arguments exactly.
- Never invent a tool name. Never put an answer in "thought".
- After a tool result comes back, reply with the next JSON object.`;
}

/**
 * Flattens the internal block format into plain chat messages, since these
 * engines accept only role + string content.
 */
export function flattenMessages(messages, { toolNameById = new Map() } = {}) {
  const out = [];

  for (const message of messages) {
    const parts = [];
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          parts.push(block.text);
          break;
        case 'image':
          parts.push('(a screenshot was taken; this model cannot see images — rely on read_page instead)');
          break;
        case 'tool_use':
          parts.push(JSON.stringify({ thought: '', tool: block.name, input: block.input }));
          break;
        case 'tool_result': {
          const name = toolNameById.get(block.tool_use_id) || 'tool';
          const body = block.content
            .map((inner) => (inner.type === 'text' ? inner.text : '(screenshot — not visible to this model)'))
            .join('\n');
          parts.push(`TOOL RESULT (${name})${block.is_error ? ' — ERROR' : ''}:\n${body}`);
          break;
        }
      }
    }
    if (parts.length) out.push({ role: message.role, content: parts.join('\n\n') });
  }
  return out;
}

/** Maps tool_use ids to names so tool results can be labelled when flattened. */
export function collectToolNames(messages) {
  const map = new Map();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') map.set(block.id, block.name);
    }
  }
  return map;
}

/** Pulls the first balanced JSON object out of a reply that may contain prose. */
function extractJsonObject(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '').trim();

  const start = cleaned.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try {
        return JSON.parse(cleaned.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

let callCounter = 0;

/**
 * Turns a raw model reply into the provider response contract.
 * A reply that isn't valid JSON is treated as a plain answer rather than an
 * error — a small model rambling in prose should still reach the user.
 */
export function parseTurn(rawText, tools) {
  const parsed = extractJsonObject(rawText);
  const known = new Set(tools.map((t) => t.name));
  const cleaned = String(rawText || '').replace(/```(?:json)?/gi, '').trim();

  // A reply that was clearly *trying* to be a tool call but came out malformed
  // must not be shown to the user as an answer — the model gets told to fix it.
  if (!parsed && /"tool"\s*:|^\s*\{/.test(cleaned)) {
    return {
      needsRetry: true,
      text: '',
      toolCalls: [],
      content: [],
      raw: cleaned.slice(0, 400),
    };
  }

  if (!parsed || !parsed.tool || parsed.tool === 'none' || !known.has(parsed.tool)) {
    const answer =
      parsed?.answer ||
      (parsed && !known.has(parsed.tool) && parsed.tool !== 'none'
        ? `I tried to use an unavailable tool ("${parsed.tool}"). ${parsed.thought || ''}`
        : null) ||
      cleaned ||
      'I could not produce a response.';

    return { text: answer, toolCalls: [], content: [{ type: 'text', text: answer }] };
  }

  const id = `local_${Date.now().toString(36)}_${++callCounter}`;
  const input = typeof parsed.input === 'object' && parsed.input !== null ? parsed.input : {};
  const content = [];
  if (parsed.thought) content.push({ type: 'text', text: parsed.thought });
  content.push({ type: 'tool_use', id, name: parsed.tool, input });

  return {
    text: parsed.thought || '',
    toolCalls: [{ id, name: parsed.tool, input }],
    content,
  };
}
