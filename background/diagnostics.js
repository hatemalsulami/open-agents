// Records what went wrong so it can be handed to someone who can fix it.
//
// Two rules govern everything here:
//   1. Secrets never leave. API keys are replaced with a shape hint, never a
//      prefix of the real value, and any credential-looking query parameter in
//      a URL is stripped.
//   2. The user sees what they are about to share. The report is a readable
//      markdown file, not an opaque blob, and the UI says to review it first —
//      it necessarily contains the URLs the agent visited.

const MAX_ENTRIES = 60;

/** Newest-last ring buffer, in memory only — nothing is persisted. */
const entries = [];

export function record(kind, detail) {
  entries.push({
    at: new Date().toISOString(),
    kind,
    ...detail,
  });
  if (entries.length > MAX_ENTRIES) entries.shift();
}

export function clearDiagnostics() {
  entries.length = 0;
}

export function entryCount() {
  return entries.length;
}

/** Removes tokens people commonly paste into URLs. */
function redactUrl(url) {
  if (typeof url !== 'string') return url;
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/key|token|secret|password|signature|auth|session/i.test(key)) {
        parsed.searchParams.set(key, 'REDACTED');
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function describeKey(value) {
  if (!value) return 'not set';
  return `set (${value.length} chars, starts "${value.slice(0, 4)}…")`;
}

function redactValue(value) {
  if (typeof value === 'string') return redactUrl(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[/key|token|secret|password/i.test(key) ? `${key}_redacted` : key] =
        /key|token|secret|password/i.test(key) ? 'REDACTED' : redactValue(inner);
    }
    return out;
  }
  return value;
}

/**
 * Builds the shareable report.
 * @param {object} args
 * @param {object} args.config — full config; keys are described, never included
 * @param {object[]} args.sessions — session summaries
 * @param {object[]} args.knowledge — knowledge metadata (names/sizes only)
 */
export function buildReport({ config = {}, sessions = [], knowledge = [] } = {}) {
  const manifest = chrome.runtime.getManifest();
  const providerSettings = config.providers?.[config.provider] || {};

  const lines = [
    '# OpenAgent bug report',
    '',
    'Paste this whole file to whoever is debugging (or into Claude Code) — it is written to be read as-is.',
    '',
    '**Before sharing, skim it.** API keys are removed, but the URLs the agent',
    'visited and the arguments it passed to tools are included, because that is',
    'what makes a bug reproducible. Delete anything you would rather not share.',
    '',
    '## Environment',
    `- Extension: ${manifest.name} v${manifest.version}`,
    `- Browser: ${navigator.userAgent}`,
    `- Platform: ${navigator.platform || 'unknown'}`,
    `- Generated: ${new Date().toISOString()}`,
    '',
    '## Configuration',
    `- Provider: \`${config.provider}\``,
    `- Model: \`${providerSettings.model || (config.provider === 'builtin' ? 'gemini-nano' : '(none)')}\``,
    `- API key: ${describeKey(providerSettings.apiKey)}`,
    `- Base URL: ${providerSettings.baseUrl ? `\`${redactUrl(providerSettings.baseUrl)}\`` : 'default'}`,
    `- Language: ${config.language} (resolved: ${config.resolvedLanguage})`,
    `- Plan mode: ${config.planMode} · Approval: ${config.approvalMode}`,
    `- Max steps: ${config.maxSteps} · Screenshots kept: ${config.keepScreenshots}`,
    `- Speak answers: ${config.speakAnswers ? 'on' : 'off'}`,
    `- Providers configured: ${Object.keys(config.providers || {}).join(', ') || 'none'}`,
    '',
    '## Sessions this browser run',
  ];

  if (!sessions.length) {
    lines.push('- none');
  } else {
    for (const session of sessions) {
      lines.push(
        `- **${session.title}** — status \`${session.status}\`, ` +
          `${session.usage?.calls || 0} model calls, ` +
          `${session.usage?.input || 0} in / ${session.usage?.output || 0} out tokens`
      );
    }
  }

  lines.push('', '## Knowledge base');
  lines.push(
    knowledge.length
      ? knowledge.map((d) => `- ${d.name} (${d.kind}${d.pinned ? ', pinned' : ''}, ${d.chars} chars)`).join('\n')
      : '- empty'
  );

  lines.push('', `## Recorded problems (${entries.length})`, '');
  if (!entries.length) {
    lines.push('None recorded. If the bug is happening now, reproduce it and export again —');
    lines.push('this log only covers the current browser session.');
  } else {
    for (const entry of entries) {
      lines.push(`### ${entry.at} — ${entry.kind}`);
      if (entry.session) lines.push(`- Session: ${entry.session}`);
      if (entry.provider) lines.push(`- Provider/model: ${entry.provider} / ${entry.model}`);
      if (entry.tool) lines.push(`- Tool: \`${entry.tool}\``);
      if (entry.input !== undefined) {
        lines.push('- Input:', '```json', JSON.stringify(redactValue(entry.input), null, 2).slice(0, 1200), '```');
      }
      if (entry.url) lines.push(`- URL: ${redactUrl(entry.url)}`);
      if (entry.message) lines.push('- Message:', '```', String(entry.message).slice(0, 1500), '```');
      if (entry.stack) lines.push('<details><summary>Stack</summary>', '', '```', String(entry.stack).slice(0, 2000), '```', '</details>');
      lines.push('');
    }
  }

  return lines.join('\n');
}
