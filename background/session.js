// A Session is one agent: its conversation, its event log (what the UI renders
// and what exports contain), its Chrome tab group, and its running task.
//
// Two parallel records are kept on purpose:
//   messages  — what the model sees. Aggressively pruned to save tokens.
//   events    — what the human sees. Never pruned; screenshots kept for export.

export const SESSION_COLORS = ['blue', 'purple', 'green', 'orange', 'pink', 'cyan', 'yellow', 'red'];

const MAX_ARTIFACTS = 40;

let counter = 0;

export class Session {
  constructor({ title, colorIndex = 0 }) {
    this.id = `s${Date.now().toString(36)}${(++counter).toString(36)}`;
    this.title = title || 'New agent';
    this.color = SESSION_COLORS[colorIndex % SESSION_COLORS.length];
    this.createdAt = new Date().toISOString();

    this.messages = [];
    this.events = [];
    this.artifacts = []; // screenshots kept out of the model context, for export
    this.usage = { input: 0, output: 0, calls: 0 };

    this.status = 'idle'; // idle | running | waiting | error
    this.run = null;
    this.approvalResolver = null;
    this.tabId = null;
    this.groupId = null;
    this.autoTitled = false;

    // Live activity for the board: what the agent is doing right now.
    this.activity = { action: '', page: '', url: '', step: 0, maxSteps: 0 };
    this.endedAt = null;
  }

  /** Records the current action + page, so the board can show it live. */
  setActivity(patch) {
    this.activity = { ...this.activity, ...patch };
  }

  addEvent(event) {
    const entry = { ...event, at: new Date().toISOString() };
    this.events.push(entry);
    return entry;
  }

  addArtifact(artifact) {
    this.artifacts.push({ ...artifact, at: new Date().toISOString() });
    if (this.artifacts.length > MAX_ARTIFACTS) this.artifacts.shift();
  }

  /** Names the session after the first task, so the chip is recognizable. */
  maybeAutoTitle(text) {
    if (this.autoTitled) return;
    this.autoTitled = true;
    const clean = text.replace(/\s+/g, ' ').trim();
    this.title = clean.length > 38 ? `${clean.slice(0, 37)}…` : clean || 'New agent';
  }

  summary() {
    return {
      id: this.id,
      title: this.title,
      color: this.color,
      status: this.status,
      usage: this.usage,
      createdAt: this.createdAt,
      endedAt: this.endedAt,
      activity: this.activity,
      // Cheap board stats without shipping the whole event log.
      toolCount: this.events.filter((e) => e.kind === 'tool' && e.state !== 'running').length,
      screenshotCount: this.artifacts.length,
      lastMessage:
        [...this.events].reverse().find((e) => e.kind === 'assistant')?.text?.slice(0, 160) || '',
    };
  }

  snapshot() {
    return { ...this.summary(), events: this.events };
  }

  /** Everything needed to rebuild the session in an export file. */
  exportPayload() {
    return {
      ...this.summary(),
      exportedAt: new Date().toISOString(),
      events: this.events,
      artifacts: this.artifacts,
      context: this.messages.map((m) => ({
        role: m.role,
        content: m.content.map((b) =>
          b.type === 'image' ? { type: 'image', omitted: true } : b
        ),
      })),
    };
  }
}

/**
 * Trims the model-visible history in place. Old screenshots become a short
 * text note and old tool output is truncated — recent turns stay intact, so
 * the agent keeps working while token cost stops growing with every step.
 */
export function pruneContext(messages, { keepScreenshots = 2, recentTurns = 6 } = {}) {
  let imagesSeen = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const isRecent = i >= messages.length - recentTurns;
    for (const block of messages[i].content) {
      const inner = block.type === 'tool_result' ? block.content : [block];
      for (let j = 0; j < inner.length; j++) {
        const part = inner[j];
        if (part.type === 'image') {
          imagesSeen++;
          if (imagesSeen > keepScreenshots) {
            inner[j] = { type: 'text', text: '(earlier screenshot dropped to save tokens)' };
          }
        } else if (part.type === 'text' && !isRecent && part.text.length > 700) {
          inner[j] = {
            type: 'text',
            text: `${part.text.slice(0, 700)}\n…(older output truncated; re-read the page if you need it again)`,
            // Provider-specific metadata must survive pruning: Gemini rejects
            // history where a signature it issued has gone missing.
            ...(part.geminiThoughtSignature ? { geminiThoughtSignature: part.geminiThoughtSignature } : {}),
          };
        }
      }
    }
  }
  return messages;
}

/**
 * Hard-caps how many messages the model sees, keeping the opening task and the
 * most recent turns. Only safe for providers that flatten history to plain text
 * (on-device engines) — APIs with strict tool_use/tool_result pairing would
 * reject an orphaned result.
 */
export function trimHistory(messages, maxMessages = 8) {
  if (messages.length <= maxMessages) return messages;
  const first = messages[0];
  const recent = messages.slice(-(maxMessages - 1));
  messages.length = 0;
  messages.push(first, ...recent);
  return messages;
}
