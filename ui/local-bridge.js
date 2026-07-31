// Page-side bridge to on-device models. The side panel and options page cannot
// create offscreen documents (chrome.offscreen is service-worker only), so
// requests are relayed through the background worker.

export const pageLocalBridge = {
  async request(payload) {
    const response = await chrome.runtime.sendMessage({
      ...payload,
      signal: undefined,
      __openAgentLocal: true,
      target: 'background',
    });
    if (!response) throw new Error('No response from the extension background. Try reloading the extension.');
    if (!response.ok) throw new Error(response.error);
    return response.result;
  },
};

/** Subscribes to model download/load progress. Returns an unsubscribe function. */
export function onLocalProgress(handler) {
  const listener = (msg) => {
    if (msg?.__openAgentLocal === true && msg.type === 'progress') handler(msg.progress);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
