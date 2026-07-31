// Speech output for agent answers, via the browser's built-in speechSynthesis
// (no extra permission, no network, uses the voices already on the machine).
//
// Model replies are markdown aimed at eyes, so they are rewritten for ears
// before speaking: code blocks and raw URLs are dropped rather than spelled
// out character by character.

const SPEAKABLE_MAX = 1800;

export function textForSpeech(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' . ')                    // code blocks
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')                 // images
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1')           // links → their text
    .replace(/https?:\/\/\S+/g, ' ')                       // bare URLs
    .replace(/^\s*#{1,6}\s*/gm, '')                        // headings
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')                         // bullets
    .replace(/\|/g, ' ')                                   // table pipes
    .replace(/\[ref\d+\]/gi, '')                           // element refs
    .replace(/[ \t]{2,}/g, ' ')
    // Every line break becomes a sentence break, so headings and list items
    // are spoken as separate thoughts instead of running together.
    .replace(/[ \t]*\n+[ \t]*/g, '. ')
    .replace(/\s*\.\s*(?=\.)/g, '')                        // collapse ". ." runs
    .replace(/\.{2,}/g, '.')
    .replace(/([:،,;])\s*\./g, '$1')                       // no period right after punctuation
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^\.\s*/, '')
    .slice(0, SPEAKABLE_MAX);
}

export function createVoice() {
  const synth = window.speechSynthesis;
  let voices = [];
  let onVoicesChanged = null;

  function loadVoices() {
    voices = synth?.getVoices?.() || [];
    if (voices.length) onVoicesChanged?.(voices);
  }

  if (synth) {
    loadVoices();
    // Chrome populates the list asynchronously on first access.
    synth.addEventListener?.('voiceschanged', loadVoices);
  }

  /** Best available voice: the user's pick, else one matching the UI language. */
  function pickVoice(preferredUri, lang) {
    if (!voices.length) loadVoices();
    if (preferredUri) {
      const chosen = voices.find((v) => v.voiceURI === preferredUri);
      if (chosen) return chosen;
    }
    const prefix = lang === 'ar' ? 'ar' : 'en';
    return (
      voices.find((v) => v.lang?.toLowerCase().startsWith(prefix) && v.localService) ||
      voices.find((v) => v.lang?.toLowerCase().startsWith(prefix)) ||
      null
    );
  }

  return {
    get supported() {
      return !!synth;
    },

    listVoices() {
      if (!voices.length) loadVoices();
      return voices.map((v) => ({ uri: v.voiceURI, name: v.name, lang: v.lang }));
    },

    onVoices(handler) {
      onVoicesChanged = handler;
      if (voices.length) handler(voices);
    },

    speaking() {
      return !!synth?.speaking;
    },

    stop() {
      synth?.cancel();
    },

    /**
     * Speaks text, replacing anything already being spoken.
     * @returns {boolean} whether speech actually started
     */
    speak(markdown, { lang = 'en', voiceUri = '', rate = 1 } = {}) {
      if (!synth) return false;
      const text = textForSpeech(markdown);
      if (!text) return false;

      synth.cancel(); // never let two answers overlap
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = pickVoice(voiceUri, lang);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      } else {
        utterance.lang = lang === 'ar' ? 'ar-SA' : 'en-US';
      }
      utterance.rate = Math.min(Math.max(Number(rate) || 1, 0.5), 2);
      synth.speak(utterance);
      return true;
    },
  };
}
