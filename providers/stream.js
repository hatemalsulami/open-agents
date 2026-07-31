// Shared Server-Sent Events reader for the streaming provider adapters.
//
// Every provider streams over SSE but frames it differently, so this handles
// only the transport: decode bytes, split on blank lines, hand each `data:`
// payload to the caller. Provider-specific event shapes stay in their adapter.

/**
 * Iterates the `data:` payloads of an SSE response.
 * @param {Response} response
 * @yields {string} one raw payload (already stripped of the "data: " prefix)
 */
export async function* sseEvents(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('This response cannot be streamed.');

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line; \r\n\r\n appears behind proxies.
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + buffer.slice(boundary).match(/^\r?\n\r?\n/)[0].length);

        for (const line of chunk.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue; // ignore `event:` / comments
          const payload = line.slice(5).trim();
          if (payload && payload !== '[DONE]') yield payload;
        }
      }
    }
  } finally {
    // Aborting mid-stream must not leak the connection.
    reader.cancel().catch(() => {});
  }
}

/** Parses an SSE payload, ignoring anything malformed. */
export function parseJson(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Throttles token deltas into UI updates. Emitting on every token floods the
 * message port and makes the panel janky; ~60ms batches read as smooth.
 */
export function createThrottledEmitter(emit, intervalMs = 60) {
  let pending = '';
  let timer = null;

  const flush = () => {
    timer = null;
    if (!pending) return;
    const text = pending;
    pending = '';
    emit(text);
  };

  return {
    push(delta) {
      if (!delta) return;
      pending += delta;
      if (!timer) timer = setTimeout(flush, intervalMs);
    },
    flush() {
      if (timer) clearTimeout(timer);
      flush();
    },
  };
}
