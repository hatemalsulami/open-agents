// Side panel controller: agent session chips, chat rendering, inline provider
// setup, routines, and exports. All agent state lives in the service worker;
// this renders the event stream it sends.

import { renderMarkdown } from './markdown.js';
import { createMentionController } from './mentions.js';
import { createVoice } from './voice.js';
import { createKnowledgeView } from './knowledge-view.js';
import { createBoardView } from './board-view.js';
import { applyIcons, setIcon, icon, iconButton as makeIconButton } from '../ui/icons.js';
import { formatCost } from '../providers/pricing.js';
import { t, applyLanguage, getLanguage, locale } from '../ui/i18n.js';
import { createSetupForm, loadConfig } from '../ui/setup.js';
import { exportHtml, exportJson } from './export.js';
import { PROVIDER_INFO, configProblem } from '../providers/index.js';

// Schedules are described here rather than in routines.js so they can be
// localized — the background module has no access to the UI language.
const DAY_KEYS = ['day.0', 'day.1', 'day.2', 'day.3', 'day.4', 'day.5', 'day.6'];
function describeSchedule(schedule) {
  if (!schedule) return t('sched.none');
  switch (schedule.type) {
    case 'daily': return t('sched.daily', schedule.time);
    case 'weekdays': return t('sched.weekdays', schedule.time);
    case 'weekly': return t('sched.weekly', t(DAY_KEYS[schedule.day ?? 1]), schedule.time);
    case 'interval': return t('sched.interval', schedule.minutes);
    case 'once': return t('sched.once', new Date(schedule.at).toLocaleString(locale()));
    default: return t('sched.none');
  }
}

const $ = (id) => document.getElementById(id);

const ui = {
  messages: $('messages'),
  chips: $('session-chips'),
  input: $('input'),
  send: $('send-btn'),
  stop: $('stop-btn'),
  statusBar: $('status-bar'),
  statusText: $('status-text'),
  usageText: $('usage-text'),
  approvalBar: $('approval-bar'),
  approvalQuestion: $('approval-question'),
  approvalArgs: $('approval-args'),
  badge: $('model-badge'),
  setupCard: $('setup-card'),
  chatView: $('chat-view'),
  routinesView: $('routines-view'),
  routinesList: $('routines-list'),
  footer: $('composer-footer'),
};

let port = null;
let sessions = [];
let activeId = null;
const snapshots = new Map(); // sessionId -> events[]
const usageBySession = new Map();
let editingRoutineId = null;
let pendingExportFormat = 'html';
let voiceConfig = { speakAnswers: false, voiceUri: '', voiceRate: 1 };
let currency = 'USD';
const voice = createVoice();
const knowledgeView = createKnowledgeView({ post });
const boardView = createBoardView({
  post,
  getCurrency: () => currency,
  onOpenSession: (id) => { showView('chat'); selectSession(id); },
  onNewAgent: () => { post({ type: 'create_session' }); showView('chat'); },
});
let languageSetting = 'auto';

// Tab mentions typed with "@" become the next task's scope.
const mentionsCtl = createMentionController({
  textarea: $('input'),
  chipsEl: $('mention-chips'),
  overlayEl: $('mention-picker'),
});

// ------------------------------------------------------------------ port

function connect() {
  port = chrome.runtime.connect({ name: 'panel' });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => { port = null; });
  port.postMessage({ type: 'hello' });
}

function post(message) {
  if (!port) connect();
  port.postMessage(message);
}

function onMessage(msg) {
  switch (msg.type) {
    case 'sessions': {
      sessions = msg.sessions;
      if (!sessions.find((s) => s.id === activeId)) activeId = sessions[0]?.id || null;
      renderChips();
      renderStatus();
      if (activeId && !snapshots.has(activeId)) post({ type: 'get_session', sessionId: activeId });
      break;
    }

    case 'session_snapshot': {
      const { session, focus } = msg;
      snapshots.set(session.id, session.events);
      usageBySession.set(session.id, session.usage);
      if (focus) activeId = session.id;
      if (session.id === activeId) renderTranscript();
      renderChips();
      break;
    }

    case 'event': {
      const events = snapshots.get(msg.sessionId) || [];
      events.push(msg.event);
      snapshots.set(msg.sessionId, events);
      if (msg.sessionId === activeId) {
        if (msg.event.kind === 'status') renderStatus(msg.event);
        else appendEvent(msg.event);
        if (msg.event.kind === 'usage') {
          usageBySession.set(msg.sessionId, msg.event.usage);
          renderStatus();
        }
      }
      break;
    }

    case 'routines':
      renderRoutines(msg.routines);
      break;

    case 'knowledge':
      knowledgeView.render({ docs: msg.docs, diagnostics: msg.diagnostics });
      break;

    case 'board':
      boardView.render({ sessions: msg.sessions, history: msg.history });
      break;

    case 'board_live':
      if (!$('board-view').classList.contains('hidden')) boardView.renderLive(msg.sessions);
      break;

    case 'bug_report_data':
      knowledgeView.downloadReport(msg.markdown);
      break;

    case 'export_data':
      pendingExportFormat === 'json' ? exportJson(msg.payload) : exportHtml(msg.payload);
      break;

    case 'toast':
      $('r-status').textContent = msg.text;
      $('r-status').className = `setup-status ${msg.error ? 'err' : 'ok'}`;
      break;
  }
}

// --------------------------------------------------------------- rendering

function activeSession() {
  return sessions.find((s) => s.id === activeId);
}

function renderChips() {
  ui.chips.innerHTML = '';
  for (const session of sessions) {
    const chip = document.createElement('div');
    chip.className = `chip${session.id === activeId ? ' active' : ''}`;
    chip.title = `${session.title}\n${t('session.rename')}`;

    const dot = document.createElement('span');
    dot.className = `status-dot ${session.status}`;
    const title = document.createElement('span');
    title.className = 'chip-title';
    title.textContent = session.title;
    const close = document.createElement('span');
    close.className = 'chip-close';
    close.appendChild(icon('x', { size: 12 }));

    chip.append(dot, title, close);
    chip.addEventListener('click', () => selectSession(session.id));
    chip.addEventListener('dblclick', () => {
      const next = prompt(t('session.renamePrompt'), session.title);
      if (next) post({ type: 'rename_session', sessionId: session.id, title: next });
    });
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      post({ type: 'close_session', sessionId: session.id, closeTabs: false });
      snapshots.delete(session.id);
    });
    ui.chips.appendChild(chip);
  }
}

function selectSession(id) {
  voice.stop();
  activeId = id;
  renderChips();
  if (snapshots.has(id)) renderTranscript();
  else post({ type: 'get_session', sessionId: id });
  renderStatus();
  ui.input.focus();
}

function renderStatus(statusEvent) {
  const session = activeSession();
  const running = session?.status === 'running' || session?.status === 'waiting';
  ui.statusBar.classList.toggle('hidden', !running);
  ui.send.disabled = !!running;
  if (!running) ui.approvalBar.classList.add('hidden');
  if (statusEvent?.kind === 'status') {
    ui.statusText.textContent = statusEvent.status === 'planning'
      ? t('status.planning')
      : t('status.thinking', statusEvent.step, statusEvent.maxSteps);
  }
  const usage = usageBySession.get(activeId);
  if (usage?.calls) {
    const cost = usage.costUsd
      ? `${usage.rateKnown ? '≈' : '~'}${formatCost(usage.costUsd, currency)} · `
      : '';
    ui.usageText.textContent =
      cost + t('status.usage', usage.calls, usage.input.toLocaleString(locale()), usage.output.toLocaleString(locale()));
    ui.usageText.title = t('status.costTip');
  } else {
    ui.usageText.textContent = '';
  }
}

function renderTranscript() {
  ui.messages.innerHTML = '';
  const events = snapshots.get(activeId) || [];
  if (!events.length) {
    renderEmptyState();
    return;
  }
  for (const event of events) appendEvent(event, false);
  scrollToBottom();
}

async function renderEmptyState() {
  const problem = configProblem(await loadConfig());
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';

  const mark = document.createElement('div');
  mark.className = 'empty-mark';
  mark.appendChild(icon(problem ? 'sliders' : 'sparkle', { size: 26 }));

  const title = document.createElement('div');
  title.className = 't';
  const hint = document.createElement('div');
  hint.className = 'h';

  if (problem) {
    title.textContent = t('empty.connectTitle');
    hint.textContent = t('empty.connectHint');
    const cta = document.createElement('button');
    cta.className = 'setup-cta';
    cta.textContent = t('empty.openSetup');
    cta.addEventListener('click', () => toggleSetup(true));
    const why = document.createElement('div');
    why.className = 'h small';
    why.textContent = problem;
    wrap.append(mark, title, hint, cta, why);
    ui.messages.appendChild(wrap);
    return;
  }

  title.textContent = t('empty.taskTitle');
  hint.textContent = t('empty.taskHint');
  wrap.append(mark, title, hint);

  // Clicking an example loads it into the composer, so the first task costs no
  // typing and shows the kind of instruction that works well.
  const examples = document.createElement('div');
  examples.className = 'examples';
  for (const key of ['empty.ex1', 'empty.ex2', 'empty.ex3', 'empty.ex4']) {
    const chip = document.createElement('button');
    chip.className = 'example-chip';
    chip.textContent = t(key);
    chip.addEventListener('click', () => {
      ui.input.value = t(key);
      autosize();
      ui.input.focus();
    });
    examples.appendChild(chip);
  }
  wrap.appendChild(examples);

  const tip = document.createElement('div');
  tip.className = 'h small';
  tip.textContent = t('empty.tip');
  wrap.appendChild(tip);

  ui.messages.appendChild(wrap);
}

function appendEvent(event, autoScroll = true) {
  ui.messages.querySelector('.empty-state')?.remove();
  let node = null;

  switch (event.kind) {
    case 'user':
      node = document.createElement('div');
      node.className = 'msg user';
      node.textContent = event.text;
      break;

    case 'assistant_delta': {
      // Tokens as they arrive: appended as plain text into a live bubble, then
      // replaced by the properly rendered markdown when the turn completes.
      let live = ui.messages.querySelector(`[data-stream="${CSS.escape(event.id)}"]`);
      if (!live) {
        ui.messages.querySelector('.empty-state')?.remove();
        live = document.createElement('div');
        live.className = 'msg assistant streaming';
        live.dataset.stream = event.id;
        ui.messages.appendChild(live);
      }
      live.textContent += event.text;
      if (autoScroll) scrollToBottom();
      return;
    }

    case 'assistant': {
      // Reuse the streamed bubble if there is one, so nothing is duplicated.
      const live = event.streamId
        ? ui.messages.querySelector(`[data-stream="${CSS.escape(event.streamId)}"]`)
        : null;
      node = live || document.createElement('div');
      node.className = 'msg assistant';
      node.replaceChildren(renderMarkdown(event.text), speakButton(event.text));
      delete node.dataset.stream;
      // Only auto-speak live answers; re-rendering history must stay silent.
      if (voiceConfig.speakAnswers && autoScroll) speakText(event.text);
      if (live) {
        if (autoScroll) scrollToBottom();
        return;
      }
      break;
    }

    case 'system':
      node = document.createElement('div');
      node.className = 'msg system';
      node.textContent = event.text;
      break;

    case 'error': {
      node = document.createElement('div');
      node.className = 'msg error';
      node.textContent = event.text;
      if (event.needsSetup) {
        const cta = document.createElement('button');
        cta.className = 'setup-cta';
        cta.textContent = t('empty.openSetup');
        cta.addEventListener('click', () => toggleSetup(true));
        node.appendChild(cta);
      }
      break;
    }

    case 'tool':
      node = renderToolEvent(event);
      break;

    case 'plan':
      node = renderPlan(event.steps);
      break;

    case 'plan_step':
      updatePlanStep(event.index, event.state);
      return;

    case 'approval_request':
      ui.approvalQuestion.textContent = t('approval.question', event.call.name);
      ui.approvalArgs.textContent = JSON.stringify(event.call.input || {}, null, 2);
      ui.approvalBar.classList.remove('hidden');
      ui.statusText.textContent = t('status.waitingApproval');
      return;

    case 'done':
      ui.approvalBar.classList.add('hidden');
      if (event.stopped) {
        node = document.createElement('div');
        node.className = 'msg system';
        node.textContent = t('msg.stopped');
      }
      break;

    default:
      return;
  }

  if (node) ui.messages.appendChild(node);
  if (autoScroll) scrollToBottom();
}

function speakText(text) {
  voice.speak(text, { lang: getLanguage(), voiceUri: voiceConfig.voiceUri, rate: voiceConfig.voiceRate });
}

// Every answer carries its own play button, so you can replay one message
// without turning on automatic reading.
function speakButton(text) {
  const button = document.createElement('button');
  button.className = 'speak-btn';
  button.appendChild(icon('volumeOn', { size: 13 }));
  button.title = t('voice.speak');
  button.addEventListener('click', () => {
    if (voice.speaking()) {
      voice.stop();
    } else {
      speakText(text);
    }
  });
  if (!voice.supported) button.classList.add('hidden');
  return button;
}

// The plan is rendered once as a checklist and then updated in place as the
// agent works through it.
function renderPlan(steps) {
  const card = document.createElement('div');
  card.className = 'plan-card';
  card.dataset.plan = 'current';

  const title = document.createElement('div');
  title.className = 'plan-title';
  title.append(icon('check', { size: 13 }), document.createTextNode(` ${t('plan.title')}`));
  card.appendChild(title);

  steps.forEach((step, index) => {
    const row = document.createElement('div');
    row.className = 'plan-step';
    row.dataset.step = String(index);
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.appendChild(icon('circle', { size: 13 }));
    const text = document.createElement('span');
    text.className = 'plan-text';
    text.textContent = step;
    row.append(mark, text);
    card.appendChild(row);
  });
  return card;
}

const PLAN_MARKS = { running: 'circleDot', done: 'check', error: 'x' };

function updatePlanStep(index, state) {
  const cards = ui.messages.querySelectorAll('[data-plan="current"]');
  const card = cards[cards.length - 1];
  const row = card?.querySelector(`[data-step="${index}"]`);
  if (!row) return;
  row.className = `plan-step ${state}`;
  setIcon(row.querySelector('.mark'), PLAN_MARKS[state] || 'circle', { size: 13 });
}

// Tool events arrive twice (running, then ok/error); the second updates in place.
function renderToolEvent(event) {
  const existing = ui.messages.querySelector(`[data-tool-id="${CSS.escape(event.id)}"]`);
  const details = existing || document.createElement('details');

  if (!existing) {
    details.className = 'tool-chip';
    details.dataset.toolId = event.id;
    const summary = document.createElement('summary');
    summary.append(
      Object.assign(document.createElement('span'), { className: 'status-dot' }),
      Object.assign(document.createElement('span'), { className: 'tool-name' }),
      Object.assign(document.createElement('span'), { className: 'tool-hint' })
    );
    const body = document.createElement('div');
    body.className = 'tool-body';
    details.append(summary, body);
  }

  const dotClass = { running: 'running', ok: '', error: 'error', denied: 'error' }[event.state] ?? '';
  details.querySelector('.status-dot').className = `status-dot ${dotClass}`;
  details.querySelector('.status-dot').style.background = event.state === 'ok' ? 'var(--ok)' : '';
  details.querySelector('.tool-name').textContent = event.name;
  details.querySelector('.tool-hint').textContent =
    event.summary || String(event.input?.url || event.input?.text || event.input?.ref || '').slice(0, 46);

  const body = details.querySelector('.tool-body');
  body.textContent = JSON.stringify(event.input || {}, null, 2);
  if (event.detail) body.textContent += `\n\n→ ${event.detail}`;

  if (event.imageDataUrl && !details.querySelector('img')) {
    const img = document.createElement('img');
    img.src = event.imageDataUrl;
    img.alt = 'Screenshot taken by the agent';
    details.appendChild(img);
  }
  return existing ? null : details;
}

function scrollToBottom() {
  ui.chatView.scrollTop = ui.chatView.scrollHeight;
}

// ------------------------------------------------------------------ actions

async function send() {
  const text = ui.input.value.trim();
  if (!text || !activeId) return;
  const session = activeSession();
  if (session?.status === 'running' || session?.status === 'waiting') return;

  ui.input.value = '';
  autosize();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // First task of a session inherits the tab you're looking at; later ones stay
  // in the tab that agent already owns. Mentioned tabs override both.
  const isFirst = !(snapshots.get(activeId) || []).some((e) => e.kind === 'user');
  post({
    type: 'start',
    sessionId: activeId,
    text,
    tabId: isFirst ? tab?.id : undefined,
    mentions: mentionsCtl.getMentions(),
    restrictOrigins: mentionsCtl.getRestrictOrigins(),
  });
  mentionsCtl.clear();
}

function autosize() {
  ui.input.style.height = 'auto';
  ui.input.style.height = `${Math.min(ui.input.scrollHeight, 130)}px`;
}

function requestExport(format) {
  pendingExportFormat = format;
  post({ type: 'export', sessionId: activeId });
}

// -------------------------------------------------------------------- setup

const setupForm = createSetupForm($('setup-form'), {
  onSaved: () => {
    refreshBadge();
    if (!(snapshots.get(activeId) || []).length) renderTranscript();
  },
});

function toggleSetup(show) {
  const visible = show ?? ui.setupCard.classList.contains('hidden');
  ui.setupCard.classList.toggle('hidden', !visible);
  if (visible) setupForm.load();
}

async function refreshBadge() {
  const config = await loadConfig();
  const settings = config.providers?.[config.provider] || {};
  const problem = configProblem(config);
  ui.badge.classList.toggle('unset', !!problem);
  ui.badge.textContent = problem ? t('badge.unconfigured') : (settings.model || PROVIDER_INFO[config.provider]?.label);
  ui.badge.title = problem || `${PROVIDER_INFO[config.provider]?.label} · ${settings.model} — click to change`;
}

// ----------------------------------------------------------------- routines

function renderRoutines(routines) {
  ui.routinesList.innerHTML = '';
  if (!routines.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = t('routines.empty');
    ui.routinesList.appendChild(empty);
    return;
  }

  for (const routine of routines) {
    const card = document.createElement('div');
    card.className = `routine${routine.enabled ? '' : ' disabled'}`;

    const top = document.createElement('div');
    top.className = 'r-top';
    const left = document.createElement('div');
    left.style.minWidth = '0';
    const name = document.createElement('div');
    name.className = 'r-name';
    name.textContent = routine.name;
    const when = document.createElement('div');
    when.className = 'r-when';
    when.textContent = `${describeSchedule(routine.schedule)}${routine.enabled ? '' : ` — ${t('routines.paused')}`}`;
    left.append(name, when);

    const actions = document.createElement('div');
    actions.className = 'r-actions';
    actions.append(
      iconButton('play', t('routines.runNow'), () => post({ type: 'routine_run', id: routine.id })),
      iconButton(routine.enabled ? 'pause' : 'play', t(routine.enabled ? 'routines.pause' : 'routines.enable'), () =>
        post({ type: 'routine_save', routine: { ...routine, enabled: !routine.enabled } })
      ),
      iconButton('pencil', t('routines.edit'), () => fillRoutineForm(routine)),
      iconButton('trash', t('routines.delete'), () => {
        if (confirm(t('routines.deleteConfirm', routine.name))) post({ type: 'routine_delete', id: routine.id });
      })
    );
    top.append(left, actions);

    const prompt = document.createElement('div');
    prompt.className = 'r-prompt';
    prompt.textContent = routine.prompt;
    card.append(top, prompt);

    if (routine.lastRun) {
      const last = document.createElement('div');
      last.className = 'r-last';
      last.textContent = `${t('routines.lastRun', new Date(routine.lastRun).toLocaleString(locale()))}${routine.lastResult ? ` — ${routine.lastResult.slice(0, 90)}` : ''}`;
      card.appendChild(last);
    }
    ui.routinesList.appendChild(card);
  }
}

// Thin wrapper so existing call sites keep their (icon, label, handler) shape.
function iconButton(name, title, onClick) {
  return makeIconButton(name, title, onClick);
}

function routineScheduleFromForm() {
  const type = $('r-type').value;
  switch (type) {
    case 'weekly': return { type, time: $('r-time').value, day: Number($('r-day').value) };
    case 'interval': return { type, minutes: Number($('r-interval').value) || 60 };
    case 'once': return { type, at: new Date($('r-once').value).toISOString() };
    default: return { type, time: $('r-time').value };
  }
}

function syncRoutineFields() {
  const type = $('r-type').value;
  $('r-time-field').classList.toggle('hidden', type === 'interval' || type === 'once');
  $('r-day-field').classList.toggle('hidden', type !== 'weekly');
  $('r-interval-field').classList.toggle('hidden', type !== 'interval');
  $('r-once-field').classList.toggle('hidden', type !== 'once');
}

function fillRoutineForm(routine) {
  editingRoutineId = routine.id;
  $('routine-form-title').textContent = t('routines.formEdit', routine.name);
  $('r-name').value = routine.name;
  $('r-prompt').value = routine.prompt;
  $('r-url').value = routine.url || '';
  $('r-type').value = routine.schedule?.type || 'daily';
  if (routine.schedule?.time) $('r-time').value = routine.schedule.time;
  if (routine.schedule?.day != null) $('r-day').value = String(routine.schedule.day);
  if (routine.schedule?.minutes) $('r-interval').value = routine.schedule.minutes;
  if (routine.schedule?.at) $('r-once').value = new Date(routine.schedule.at).toISOString().slice(0, 16);
  $('r-cancel').classList.remove('hidden');
  syncRoutineFields();
  ui.routinesView.scrollTop = ui.routinesView.scrollHeight;
}

function resetRoutineForm() {
  editingRoutineId = null;
  $('routine-form-title').textContent = t('routines.formNew');
  $('r-name').value = '';
  $('r-prompt').value = '';
  $('r-url').value = '';
  $('r-status').textContent = '';
  $('r-cancel').classList.add('hidden');
}

// ------------------------------------------------------------------- wiring

ui.send.addEventListener('click', send);
ui.input.addEventListener('input', autosize);
ui.input.addEventListener('keydown', (e) => {
  if (mentionsCtl.handleKeyDown(e)) return; // picker consumed the key
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

ui.stop.addEventListener('click', () => {
  voice.stop();
  post({ type: 'stop', sessionId: activeId });
});
$('approve-btn').addEventListener('click', () => {
  ui.approvalBar.classList.add('hidden');
  post({ type: 'approval', sessionId: activeId, approved: true });
});
$('deny-btn').addEventListener('click', () => {
  ui.approvalBar.classList.add('hidden');
  post({ type: 'approval', sessionId: activeId, approved: false });
});

$('new-session').addEventListener('click', () => post({ type: 'create_session' }));
$('toggle-setup').addEventListener('click', () => toggleSetup());
$('open-dashboard').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('setup-dashboard').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('close-setup').addEventListener('click', () => toggleSetup(false));
ui.badge.addEventListener('click', () => toggleSetup(true));

// One registry drives tab switching; adding a view means adding a row here.
const VIEWS = {
  chat: { main: 'chat-view', tab: 'tab-chat', onShow: null },
  board: { main: 'board-view', tab: 'tab-board', onShow: () => boardView.refresh() },
  routines: { main: 'routines-view', tab: 'tab-routines', onShow: () => post({ type: 'routines_get' }) },
  knowledge: { main: 'knowledge-view', tab: 'tab-knowledge', onShow: () => knowledgeView.refresh() },
};

function showView(name) {
  for (const [id, view] of Object.entries(VIEWS)) {
    $(view.main).classList.toggle('hidden', id !== name);
    $(view.tab).classList.toggle('active', id === name);
  }
  const isChat = name === 'chat';
  ui.footer.classList.toggle('hidden', !isChat);
  $('session-bar').classList.toggle('hidden', !isChat);
  VIEWS[name].onShow?.();
}
for (const [id, view] of Object.entries(VIEWS)) {
  $(view.tab).addEventListener('click', () => showView(id));
}

$('r-type').addEventListener('change', syncRoutineFields);
$('r-cancel').addEventListener('click', resetRoutineForm);
$('r-save').addEventListener('click', () => {
  const prompt = $('r-prompt').value.trim();
  if (!prompt) {
    $('r-status').textContent = t('routines.needTask');
    $('r-status').className = 'setup-status err';
    return;
  }
  post({
    type: 'routine_save',
    routine: {
      id: editingRoutineId,
      name: $('r-name').value.trim() || prompt.slice(0, 30),
      prompt,
      url: $('r-url').value.trim(),
      schedule: routineScheduleFromForm(),
      enabled: true,
    },
  });
  resetRoutineForm();
  $('r-status').textContent = t('setup.saved');
  $('r-status').className = 'setup-status ok';
});

// Export menu lives on the chat view header via keyboard-free UI: a long-press
// free approach — an explicit button pair added to the session bar.
const exportHtmlBtn = iconButton('download', t('session.export'), () => requestExport('html'));
const exportJsonBtn = iconButton('braces', t('session.exportJson'), () => requestExport('json'));
$('session-bar').append(exportHtmlBtn, exportJsonBtn);

async function applyStoredLanguage() {
  const config = await loadConfig();
  languageSetting = config.language || 'auto';
  const resolved = applyLanguage(languageSetting);
  // The worker cannot resolve navigator.language, so it is told which language
  // the UI settled on and asks the agent to reply in it.
  if (config.resolvedLanguage !== resolved) {
    await chrome.storage.local.set({ config: { ...config, resolvedLanguage: resolved } });
  }
  // Re-render anything built in JavaScript rather than from the HTML.
  currency = config.currency || 'USD';
  voiceConfig = {
    speakAnswers: !!config.speakAnswers,
    voiceUri: config.voiceUri || '',
    voiceRate: config.voiceRate || 1,
  };
  applyIcons();
  renderVoiceButton();
  // The globe button shows the language you'd switch TO, which is clearer than a globe alone.
  $('toggle-lang').textContent = getLanguage() === 'ar' ? 'EN' : 'ع';
  mentionsCtl.refreshLabels();
  refreshBadge();
  if (!(snapshots.get(activeId) || []).length) renderTranscript();
  if (!$('routines-view').classList.contains('hidden')) post({ type: 'routines_get' });
  if (!editingRoutineId) $('routine-form-title').textContent = t('routines.formNew');
}

function renderVoiceButton() {
  const button = $('toggle-voice');
  button.classList.toggle('active', voiceConfig.speakAnswers);
  setIcon(button, voiceConfig.speakAnswers ? 'volumeOn' : 'volumeOff');
  button.title = t(voiceConfig.speakAnswers ? 'voice.toggleOn' : 'voice.toggleOff');
  button.disabled = !voice.supported;
  if (!voice.supported) button.title = t('voice.unsupported');
}

$('toggle-voice').addEventListener('click', async () => {
  const config = await loadConfig();
  const next = !config.speakAnswers;
  voice.stop();
  await chrome.storage.local.set({ config: { ...config, speakAnswers: next } });
  voiceConfig = { ...voiceConfig, speakAnswers: next };
  renderVoiceButton();
});

$('toggle-lang').addEventListener('click', async () => {
  const config = await loadConfig();
  const next = getLanguage() === 'ar' ? 'en' : 'ar';
  await chrome.storage.local.set({ config: { ...config, language: next } });
  await applyStoredLanguage();
});

chrome.storage.onChanged.addListener((changes) => {
  if (!changes.config) return;
  refreshBadge();
  const next = changes.config.newValue?.language || 'auto';
  if (next !== languageSetting) applyStoredLanguage();
});

window.addEventListener('error', (event) => {
  post({ type: 'panel_error', message: event.message, stack: event.error?.stack, url: event.filename });
});
window.addEventListener('unhandledrejection', (event) => {
  post({ type: 'panel_error', message: String(event.reason?.message || event.reason) });
});

connect();
applyStoredLanguage();
syncRoutineFields();
ui.input.focus();
