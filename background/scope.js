// Scope: the boundary a user draws around an agent by mentioning tabs.
//
// Without a scope an agent may use any tab. With one, it starts on the
// mentioned tabs and — when locked — cannot navigate away from their sites.
// Enforcement lives here rather than in the prompt, because a prompt is a
// request and this is a guarantee.

export function createScope({ tabs = [], restrictOrigins = false } = {}) {
  const tabIds = new Set(tabs.map((tab) => tab.tabId).filter((id) => typeof id === 'number'));
  const origins = new Set();

  for (const tab of tabs) {
    const origin = originOf(tab.url);
    if (origin) origins.add(origin);
  }

  return {
    active: tabIds.size > 0,
    restrictOrigins: restrictOrigins && origins.size > 0,
    tabIds,
    origins,
    tabs: tabs.map((tab) => ({ tabId: tab.tabId, url: tab.url, title: tab.title })),
  };
}

export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Lets tabs the agent legitimately opened inside scope stay usable. */
export function admitTab(scope, tabId) {
  if (scope?.active) scope.tabIds.add(tabId);
}

export function checkTabAllowed(scope, tabId) {
  if (!scope?.active || scope.tabIds.has(tabId)) return;
  throw new Error(
    `Tab ${tabId} is outside the scope you were given. You may only work in: ${describeScopeTabs(scope)}.`
  );
}

export function checkUrlAllowed(scope, url) {
  if (!scope?.active || !scope.restrictOrigins) return;
  const origin = originOf(url);
  if (origin && scope.origins.has(origin)) return;
  throw new Error(
    `Navigating to ${url} is blocked: this task is locked to ${[...scope.origins].join(', ')}. ` +
      'Tell the user if the task cannot be completed within those sites.'
  );
}

function describeScopeTabs(scope) {
  return scope.tabs.map((tab) => `[${tab.tabId}] ${tab.title || tab.url}`).join(', ');
}

/** The scope note appended to the agent's first message. */
export function describeScopeForModel(scope) {
  if (!scope?.active) return '';
  const list = scope.tabs
    .map((tab) => `  - tab ${tab.tabId}: "${(tab.title || '').slice(0, 70)}" — ${tab.url}`)
    .join('\n');

  return (
    `\n\n[SCOPE — the user pointed you at specific tabs. Work in these only:\n${list}\n` +
    (scope.restrictOrigins
      ? `You are LOCKED to these sites: ${[...scope.origins].join(', ')}. Navigation elsewhere will be refused — if the task needs another site, stop and say so.`
      : 'You may open other pages if the task genuinely needs it, but start here.') +
    ']'
  );
}
