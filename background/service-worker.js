// Service worker: owns every agent session, runs them (in parallel), drives
// routines, and talks to the side panel over a long-lived port.

import { createProvider, DEFAULT_CONFIG, configProblem } from '../providers/index.js';
import { localBridge } from './local-host.js';
import { createScope, describeScopeForModel } from './scope.js';
import { AgentRun } from './agent.js';
import { clearPageActivity } from './tools.js';
import * as cdp from './cdp.js';
import { pinnedContext, hasKnowledge, listKnowledge, addDoc, updateDoc, deleteDoc } from './knowledge.js';
import { record, buildReport, clearDiagnostics, entryCount } from './diagnostics.js';
import { Session, SESSION_COLORS } from './session.js';
import {
  getRoutines, saveRoutine, deleteRoutine, recordRun,
  scheduleRoutine, rescheduleAll, routineIdFromAlarm,
} from './routines.js';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

/** @type {Map<string, Session>} */
const sessions = new Map();
let sessionsCreated = 0;
let panelPort = null;

async function loadConfig() {
  const { config } = await chrome.storage.local.get('config');
  const merged = { ...DEFAULT_CONFIG, ...(config || {}) };
  // The worker has no navigator.language worth trusting, so the panel records
  // the language it actually resolved and the agent replies in it.
  merged.resolvedLanguage = merged.resolvedLanguage || 'en';
  // Knowledge lives outside config but the agent reads it as part of its setup.
  merged.hasKnowledge = await hasKnowledge();
  merged.pinnedKnowledge = await pinnedContext();
  return merged;
}

function send(message) {
  try {
    panelPort?.postMessage(message);
  } catch {
    // panel closed; agents keep running
  }
}

function broadcastSessions() {
  const summaries = [...sessions.values()].map((s) => s.summary());
  send({ type: 'sessions', sessions: summaries });
  // The board renders from the same summaries, so keep it live for free.
  send({ type: 'board_live', sessions: summaries });
}

function emitTo(session, event) {
  const entry = session.addEvent(event);
  send({ type: 'event', sessionId: session.id, event: entry });
}

function setStatus(session, status) {
  session.status = status;
  broadcastSessions();
}

function createSession(title) {
  const session = new Session({ title, colorIndex: sessionsCreated++ });
  sessions.set(session.id, session);
  broadcastSessions();
  return session;
}

// ---------------------------------------------------------------- tab groups

const TAB_GROUP_COLORS = new Set(SESSION_COLORS);

async function addTabToGroup(session, tabId) {
  if (!chrome.tabGroups) return;
  try {
    const groupId = await chrome.tabs.group(
      session.groupId ? { tabIds: [tabId], groupId: session.groupId } : { tabIds: [tabId] }
    );
    if (session.groupId !== groupId) {
      session.groupId = groupId;
      await chrome.tabGroups.update(groupId, {
        title: session.title.slice(0, 30),
        color: TAB_GROUP_COLORS.has(session.color) ? session.color : 'blue',
      });
    }
  } catch {
    // grouping is a convenience — a failure must never stop the agent
  }
}

// -------------------------------------------------------------------- runner

async function runTask(session, text, { tabId, notifyOnDone = false, mentions = [], restrictOrigins = false } = {}) {
  if (session.run) {
    emitTo(session, { kind: 'error', text: 'This agent is already working. Stop it first.' });
    return;
  }

  let config, provider;
  try {
    config = await loadConfig();
    provider = createProvider(config, { localBridge });
  } catch (err) {
    record('setup-error', { session: session.title, message: err.message });
    emitTo(session, { kind: 'error', text: err.message, needsSetup: true });
    setStatus(session, 'error');
    return;
  }

  session.maybeAutoTitle(text);

  // Mentioned tabs define both the starting point and the boundary.
  const scope = createScope({ tabs: mentions, restrictOrigins });
  session.scope = scope;
  if (mentions.length) session.tabId = mentions[0].tabId;
  else if (tabId) session.tabId = tabId;

  // Every agent needs a tab it can safely drive; a fresh one avoids two agents
  // fighting over the same page.
  if (!session.tabId) {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    session.tabId = tab.id;
  }
  await addTabToGroup(session, session.tabId);

  // Telling the model where it is up front saves it a wasted orientation step.
  const situated =
    `${text}\n\n[Browser context: ${await describeStartingTab(session.tabId)}]` +
    describeScopeForModel(scope);
  session.messages.push({ role: 'user', content: [{ type: 'text', text: situated }] });
  emitTo(session, { kind: 'user', text });
  setStatus(session, 'running');

  const run = new AgentRun({
    provider,
    config,
    session,
    emit: (event) => {
      if (event.kind === 'approval_request') setStatus(session, 'waiting');
      else if (session.status === 'waiting') setStatus(session, 'running');
      trackActivity(session, event);
      if (event.kind === 'tool' && event.state === 'error') {
        record('tool-error', {
          session: session.title,
          tool: event.name,
          input: event.input,
          message: event.summary,
        });
      }
      emitTo(session, event);
    },
    requestApproval: () =>
      new Promise((resolve) => {
        session.approvalResolver = resolve;
      }),
    onTabOpened: (newTabId) => addTabToGroup(session, newTabId),
    scope,
    onTrusted: () =>
      emitTo(session, {
        kind: 'system',
        text: 'Precise input mode is active on this site — Chrome shows a debugging banner while the agent works. Click "Cancel" on it any time to stop.',
      }),
  });
  session.run = run;

  try {
    await run.run();
    setStatus(session, 'idle');
    emitTo(session, { kind: 'done', stopped: run.stopped });
    if (notifyOnDone) {
      const last = [...session.events].reverse().find((e) => e.kind === 'assistant');
      notify(session.title, last?.text || 'Finished.');
    }
  } catch (err) {
    const message = err?.message || String(err);
    record('run-error', {
      session: session.title,
      provider: config.provider,
      model: config.providers?.[config.provider]?.model,
      message,
      stack: err?.stack,
    });
    emitTo(session, { kind: 'error', text: message, needsSetup: /API key|model|provider/i.test(message) });
    setStatus(session, 'error');
    // Keep history valid: drop a dangling assistant tool_use turn with no results.
    const last = session.messages[session.messages.length - 1];
    if (last?.role === 'assistant' && last.content.some((b) => b.type === 'tool_use')) session.messages.pop();
    if (notifyOnDone) notify(`${session.title} — failed`, message);
  } finally {
    session.run = null;
    session.approvalResolver = null;
    session.endedAt = new Date().toISOString();
    session.setActivity({ action: '', step: 0, maxSteps: 0 });
    if (session.tabId) clearPageActivity(session.tabId);
    if (session.groupId != null && chrome.tabGroups) {
      chrome.tabGroups.update(session.groupId, { title: session.title.slice(0, 30) }).catch(() => {});
    }
    // Persist a compact record so the board's History survives a worker restart.
    archiveSession(session).then(() => broadcastSessions());
    // Once nothing is running, drop every debugging banner in one go.
    if (![...sessions.values()].some((s) => s.run)) cdp.detachAll();
  }
}

// Translates the agent's event stream into a one-line "what it's doing now"
// plus the page it's on, for the live board. Best-effort and cheap.
const TOOL_VERBS = {
  navigate: 'Opening a page', read_page: 'Reading the page', get_page_text: 'Reading the page',
  find: 'Looking for something', read_section: 'Reading a section', extract_links: 'Collecting links',
  click: 'Clicking', type_text: 'Typing', select_option: 'Choosing an option', scroll: 'Scrolling',
  press_key: 'Pressing a key', screenshot: 'Taking a screenshot', wait: 'Waiting',
  open_tab: 'Opening a tab', switch_tab: 'Switching tabs', list_tabs: 'Listing tabs',
  search_knowledge: 'Checking your notes', batch: 'Running a batch of actions',
};

function trackActivity(session, event) {
  if (event.kind === 'status') {
    session.setActivity({
      action: event.status === 'planning' ? 'Planning the steps' : 'Thinking',
      step: event.step,
      maxSteps: event.maxSteps,
    });
    refreshBoard(session);
  } else if (event.kind === 'tool' && event.state === 'running') {
    // A navigate/summary line carries the URL the agent moved to.
    const url = event.input?.url && /^https?:/i.test(event.input.url) ? event.input.url : session.activity.url;
    session.setActivity({ action: TOOL_VERBS[event.name] || event.name, url });
    refreshBoard(session);
  } else if (event.kind === 'tool' && event.summary?.startsWith('Now on:')) {
    // describeTab results look like: Now on: "Title" — https://…
    const match = /Now on: "([^"]*)" — (\S+)/.exec(event.summary);
    if (match) session.setActivity({ page: match[1], url: match[2] });
  }
}

// The board only needs summaries, and refreshing it must never block the run.
function refreshBoard(session) {
  syncSessionPage(session);
  broadcastSessions();
}

// Pulls the current tab's real title/url so the board shows the live page even
// when the last tool didn't report it.
async function syncSessionPage(session) {
  if (!session.tabId) return;
  try {
    const tab = await chrome.tabs.get(session.tabId);
    if (tab && /^https?:/i.test(tab.url || '')) {
      session.setActivity({ page: tab.title || session.activity.page, url: tab.url });
    }
  } catch {
    // tab gone; leave the last known page
  }
}

// ------------------------------------------------------------------- history

const HISTORY_KEY = 'sessionHistory';
const HISTORY_MAX = 100;

async function archiveSession(session) {
  const { [HISTORY_KEY]: existing } = await chrome.storage.local.get(HISTORY_KEY);
  const history = Array.isArray(existing) ? existing : [];
  const first = session.events.find((e) => e.kind === 'user');
  history.unshift({
    id: session.id,
    title: session.title,
    color: session.color,
    status: session.status,
    createdAt: session.createdAt,
    endedAt: session.endedAt,
    usage: session.usage,
    toolCount: session.events.filter((e) => e.kind === 'tool' && e.state !== 'running').length,
    firstTask: first?.text?.slice(0, 200) || '',
    lastMessage: [...session.events].reverse().find((e) => e.kind === 'assistant')?.text?.slice(0, 400) || '',
    lastUrl: session.activity.url || '',
  });
  await chrome.storage.local.set({ [HISTORY_KEY]: history.slice(0, HISTORY_MAX) });
}

async function getHistory() {
  const { [HISTORY_KEY]: history } = await chrome.storage.local.get(HISTORY_KEY);
  return Array.isArray(history) ? history : [];
}

async function describeStartingTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || tab.url === 'about:blank') {
      return 'you are on a new empty tab — navigate somewhere to begin';
    }
    return `your current tab is "${(tab.title || '').slice(0, 80)}" at ${tab.url}`;
  } catch {
    return 'no tab information available';
  }
}

function notify(title, message) {
  try {
    chrome.notifications?.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: `OpenAgent — ${title}`.slice(0, 60),
      message: (message || '').slice(0, 250),
    });
  } catch {
    // notifications are best-effort
  }
}

// ------------------------------------------------------------------ routines

chrome.tabs.onRemoved.addListener((tabId) => cdp.detach(tabId));

chrome.runtime.onInstalled.addListener(() => rescheduleAll());
chrome.runtime.onStartup.addListener(() => rescheduleAll());

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const routineId = routineIdFromAlarm(alarm.name);
  if (!routineId) return;

  const routine = (await getRoutines()).find((r) => r.id === routineId);
  if (!routine || !routine.enabled) return;

  const problem = configProblem(await loadConfig());
  if (problem) {
    notify(routine.name, `Skipped — ${problem}`);
    return;
  }

  const session = createSession(`🕒 ${routine.name}`);
  emitTo(session, { kind: 'system', text: `Routine "${routine.name}" started on schedule.` });

  let tabId = null;
  if (routine.url) {
    const tab = await chrome.tabs.create({ url: routine.url, active: false });
    tabId = tab.id;
  }

  await runTask(session, routine.prompt, { tabId, notifyOnDone: true });

  const last = [...session.events].reverse().find((e) => e.kind === 'assistant');
  await recordRun(routine.id, last?.text || '');
  // Non-interval schedules fire once, so arm the next occurrence.
  if (routine.schedule?.type !== 'interval') {
    await scheduleRoutine((await getRoutines()).find((r) => r.id === routine.id) || routine);
  }
  send({ type: 'routines', routines: await getRoutines() });
});

// ------------------------------------------------- local model relay (pages)

// The side panel and options page cannot create offscreen documents, so they
// relay on-device requests (availability, model list, test chat) through here.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.__openAgentLocal !== true || msg.target !== 'background') return false;

  (async () => {
    try {
      const { target, __openAgentLocal, ...payload } = msg;
      sendResponse({ ok: true, result: await localBridge.request(payload) });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true; // async response
});

// --------------------------------------------------------------- panel port

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  panelPort = port;

  port.onMessage.addListener(async (msg) => {
    const session = msg.sessionId ? sessions.get(msg.sessionId) : null;

    switch (msg.type) {
      case 'hello': {
        if (sessions.size === 0) createSession('New agent');
        broadcastSessions();
        send({ type: 'routines', routines: await getRoutines() });
        break;
      }

      case 'create_session': {
        const created = createSession(msg.title);
        send({ type: 'session_snapshot', session: created.snapshot(), focus: true });
        break;
      }

      case 'get_session': {
        if (session) send({ type: 'session_snapshot', session: session.snapshot() });
        break;
      }

      case 'close_session': {
        if (!session) break;
        session.run?.stop();
        session.approvalResolver?.(false);
        if (msg.closeTabs && session.groupId != null) {
          const tabs = await chrome.tabs.query({ groupId: session.groupId }).catch(() => []);
          await chrome.tabs.remove(tabs.map((t) => t.id)).catch(() => {});
        }
        sessions.delete(session.id);
        if (sessions.size === 0) createSession('New agent');
        broadcastSessions();
        break;
      }

      case 'rename_session': {
        if (!session) break;
        session.title = (msg.title || '').trim() || session.title;
        session.autoTitled = true;
        broadcastSessions();
        break;
      }

      case 'start': {
        if (session) {
          runTask(session, msg.text, {
            tabId: msg.tabId,
            mentions: msg.mentions || [],
            restrictOrigins: !!msg.restrictOrigins,
          });
        }
        break;
      }

      case 'stop': {
        session?.run?.stop();
        session?.approvalResolver?.(false);
        break;
      }

      case 'approval': {
        if (!session) break;
        session.approvalResolver?.(!!msg.approved);
        session.approvalResolver = null;
        break;
      }

      case 'export': {
        if (session) send({ type: 'export_data', payload: session.exportPayload() });
        break;
      }

      case 'board_get': {
        // Live snapshot for the board: refresh each running agent's page first.
        await Promise.all([...sessions.values()].filter((s) => s.status === 'running').map(syncSessionPage));
        send({
          type: 'board',
          sessions: [...sessions.values()].map((s) => s.summary()),
          history: await getHistory(),
        });
        break;
      }

      case 'history_clear':
        await chrome.storage.local.set({ [HISTORY_KEY]: [] });
        send({ type: 'board', sessions: [...sessions.values()].map((s) => s.summary()), history: [] });
        break;

      case 'focus_tab': {
        const target = msg.sessionId ? sessions.get(msg.sessionId)?.tabId : msg.tabId;
        try {
          const tab = await chrome.tabs.get(target);
          await chrome.windows.update(tab.windowId, { focused: true });
          await chrome.tabs.update(target, { active: true });
        } catch {
          send({ type: 'toast', text: 'That tab is no longer open.', error: true });
        }
        break;
      }

      case 'knowledge_get':
        send({ type: 'knowledge', docs: await listKnowledge(), diagnostics: entryCount() });
        break;

      case 'knowledge_add':
        try {
          await addDoc(msg.doc);
        } catch (err) {
          send({ type: 'toast', text: err.message, error: true, target: 'knowledge' });
        }
        send({ type: 'knowledge', docs: await listKnowledge(), diagnostics: entryCount() });
        break;

      case 'knowledge_update':
        await updateDoc(msg.id, msg.patch || {});
        send({ type: 'knowledge', docs: await listKnowledge(), diagnostics: entryCount() });
        break;

      case 'knowledge_delete':
        await deleteDoc(msg.id);
        send({ type: 'knowledge', docs: await listKnowledge(), diagnostics: entryCount() });
        break;

      case 'bug_report':
        send({
          type: 'bug_report_data',
          markdown: buildReport({
            config: await loadConfig(),
            sessions: [...sessions.values()].map((s) => s.summary()),
            knowledge: await listKnowledge(),
          }),
        });
        break;

      case 'diagnostics_clear':
        clearDiagnostics();
        send({ type: 'knowledge', docs: await listKnowledge(), diagnostics: entryCount() });
        break;

      case 'panel_error':
        record('panel-error', { message: msg.message, stack: msg.stack, url: msg.url });
        break;

      case 'routines_get':
        send({ type: 'routines', routines: await getRoutines() });
        break;

      case 'routine_save':
        try {
          await saveRoutine(msg.routine);
        } catch (err) {
          send({ type: 'toast', text: err.message, error: true });
        }
        send({ type: 'routines', routines: await getRoutines() });
        break;

      case 'routine_delete':
        await deleteRoutine(msg.id);
        send({ type: 'routines', routines: await getRoutines() });
        break;

      case 'routine_run': {
        const routine = (await getRoutines()).find((r) => r.id === msg.id);
        if (!routine) break;
        const manual = createSession(`🕒 ${routine.name}`);
        send({ type: 'session_snapshot', session: manual.snapshot(), focus: true });
        let tabId = null;
        if (routine.url) tabId = (await chrome.tabs.create({ url: routine.url, active: false })).id;
        runTask(manual, routine.prompt, { tabId });
        break;
      }
    }
  });

  port.onDisconnect.addListener(() => {
    if (panelPort === port) panelPort = null;
    // Pending approvals can never be answered once the panel is gone.
    for (const session of sessions.values()) {
      if (session.approvalResolver) {
        session.approvalResolver(false);
        session.approvalResolver = null;
      }
    }
  });
});
