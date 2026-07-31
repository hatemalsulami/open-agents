// The agent's second brain: files and notes you give it once, available in
// every task afterwards.
//
// The design point that matters: knowledge is NOT pasted into the prompt.
// Context is the binding constraint on this whole extension, so documents are
// chunked and *searched* on demand via the search_knowledge tool, and only the
// handful of matching passages ever reach the model. The exception is small
// "pinned" notes — facts so central (your store URL, preferred currency) that
// paying for them every turn is worth it.

const STORAGE_KEY = 'knowledge';

export const LIMITS = {
  docChars: 300_000,     // per document
  totalChars: 4_000_000, // across all documents
  pinnedChars: 2_000,    // pinned notes injected into every prompt
  chunkChars: 900,
  maxHits: 6,
};

export async function getKnowledge() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const docs = Array.isArray(stored[STORAGE_KEY]?.docs) ? stored[STORAGE_KEY].docs : [];
  return { docs };
}

async function setKnowledge(knowledge) {
  await chrome.storage.local.set({ [STORAGE_KEY]: knowledge });
}

/** Metadata only — the panel never needs full document text to list them. */
export async function listKnowledge() {
  const { docs } = await getKnowledge();
  return docs.map(({ text, ...meta }) => ({ ...meta, chars: text.length }));
}

export async function addDoc({ name, text, kind = 'file', pinned = false }) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) throw new Error('That document is empty.');
  if (clean.length > LIMITS.docChars) {
    throw new Error(`Too large: ${clean.length.toLocaleString()} characters (limit ${LIMITS.docChars.toLocaleString()}). Split it up.`);
  }

  const knowledge = await getKnowledge();
  const used = knowledge.docs.reduce((sum, d) => sum + d.text.length, 0);
  if (used + clean.length > LIMITS.totalChars) {
    throw new Error('Knowledge storage is full. Remove a document first.');
  }

  const doc = {
    id: `k${Date.now().toString(36)}${Math.floor(performance.now()).toString(36)}`,
    name: (name || 'Untitled').slice(0, 120),
    kind,
    pinned: !!pinned,
    addedAt: new Date().toISOString(),
    text: clean,
  };
  knowledge.docs.push(doc);
  await setKnowledge(knowledge);
  return { ...doc, text: undefined, chars: clean.length };
}

export async function updateDoc(id, patch) {
  const knowledge = await getKnowledge();
  const doc = knowledge.docs.find((d) => d.id === id);
  if (!doc) return null;
  if (typeof patch.pinned === 'boolean') doc.pinned = patch.pinned;
  if (typeof patch.name === 'string') doc.name = patch.name.slice(0, 120);
  if (typeof patch.text === 'string') doc.text = patch.text.trim();
  await setKnowledge(knowledge);
  return { ...doc, text: undefined, chars: doc.text.length };
}

export async function deleteDoc(id) {
  const knowledge = await getKnowledge();
  knowledge.docs = knowledge.docs.filter((d) => d.id !== id);
  await setKnowledge(knowledge);
}

/**
 * Pinned notes, concatenated for the system prompt and hard-capped so a long
 * note can never crowd out the task itself.
 */
export async function pinnedContext() {
  const { docs } = await getKnowledge();
  const pinned = docs.filter((d) => d.pinned);
  if (!pinned.length) return '';

  let budget = LIMITS.pinnedChars;
  const parts = [];
  for (const doc of pinned) {
    const slice = doc.text.slice(0, Math.max(0, budget));
    if (!slice) break;
    parts.push(`### ${doc.name}\n${slice}${slice.length < doc.text.length ? '\n…(truncated — use search_knowledge for the rest)' : ''}`);
    budget -= slice.length;
  }
  return parts.join('\n\n');
}

export async function hasKnowledge() {
  const { docs } = await getKnowledge();
  return docs.length > 0;
}

// -------------------------------------------------------------------- search

/** Splits a document on blank lines, keeping chunks near LIMITS.chunkChars. */
function chunkText(text) {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks = [];
  let current = '';

  for (const paragraph of paragraphs) {
    // A single oversized paragraph (a CSV row block, a minified blob) is cut.
    if (paragraph.length > LIMITS.chunkChars) {
      if (current) { chunks.push(current); current = ''; }
      for (let i = 0; i < paragraph.length; i += LIMITS.chunkChars) {
        chunks.push(paragraph.slice(i, i + LIMITS.chunkChars));
      }
      continue;
    }
    if ((current + paragraph).length > LIMITS.chunkChars) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function scoreChunk(chunk, tokens) {
  const text = chunk.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (token.length < 2) continue;
    // Longer matching terms are worth more; repeats count, with diminishing value.
    const occurrences = text.split(token).length - 1;
    if (occurrences) score += token.length * Math.min(occurrences, 3);
  }
  return score;
}

/**
 * Keyword search across all documents. Deliberately not an embedding index:
 * it needs no model call, no network, and no build step, and for a personal
 * knowledge base of notes and CSVs it is accurate enough.
 */
export async function searchKnowledge(query, { limit = LIMITS.maxHits, maxChars = 4000 } = {}) {
  const tokens = String(query || '').toLowerCase().split(/[\s,.;:!?()[\]{}"'/\\-]+/).filter(Boolean);
  if (!tokens.length) throw new Error('search_knowledge needs a query.');

  const { docs } = await getKnowledge();
  if (!docs.length) return 'Your knowledge base is empty. Add notes or files in the 📚 tab of the side panel.';

  const hits = [];
  for (const doc of docs) {
    for (const chunk of chunkText(doc.text)) {
      const score = scoreChunk(chunk, tokens);
      if (score > 0) hits.push({ doc: doc.name, chunk, score });
    }
  }
  if (!hits.length) {
    return `Nothing in your knowledge base matches "${query}". Documents available: ${docs.map((d) => d.name).join(', ')}.`;
  }

  hits.sort((a, b) => b.score - a.score);
  const lines = [];
  let budget = maxChars;

  for (const hit of hits.slice(0, limit)) {
    const entry = `— from "${hit.doc}":\n${hit.chunk}`;
    if (entry.length > budget) break;
    budget -= entry.length;
    lines.push(entry);
  }

  return lines.length
    ? `Matches for "${query}" in your knowledge base:\n\n${lines.join('\n\n')}`
    : `Matches exist for "${query}" but each is too large to return. Ask something more specific.`;
}
