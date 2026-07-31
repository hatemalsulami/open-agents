// Board tab — "mission control". A live card per agent showing its status, the
// page it is on, and what it is doing right now; below that, the history of
// finished sessions. Self-contained view module: panel.js forwards worker
// messages and callbacks for opening/selecting sessions.

import { t, locale } from '../ui/i18n.js';
import { formatCost } from '../providers/pricing.js';

export function createBoardView({ post, onOpenSession, onNewAgent, getCurrency = () => 'USD' }) {
  const $ = (id) => document.getElementById(id);
  const els = {
    live: $('board-live'),
    history: $('board-history'),
    historyEmpty: $('board-history-empty'),
    stats: $('board-stats'),
    clear: $('board-clear'),
  };

  els.clear.addEventListener('click', () => {
    if (confirm(t('board.clearConfirm'))) post({ type: 'history_clear' });
  });

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  }

  function relTime(iso) {
    if (!iso) return '';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return t('board.justNow');
    if (diff < 3600) return t('board.minsAgo', Math.floor(diff / 60));
    if (diff < 86400) return t('board.hoursAgo', Math.floor(diff / 3600));
    return new Date(iso).toLocaleDateString(locale());
  }

  const STATUS_LABEL = {
    running: 'board.running', waiting: 'board.waiting', idle: 'board.idle', error: 'board.error',
  };

  // --------------------------------------------------------------- live cards

  function renderLive(sessions) {
    els.live.innerHTML = '';
    const active = sessions.filter((s) => s.status === 'running' || s.status === 'waiting');
    const idle = sessions.filter((s) => s.status !== 'running' && s.status !== 'waiting');

    const running = active.length;
    els.stats.textContent = running
      ? t('board.activeCount', running, sessions.length)
      : t('board.noneActive', sessions.length);

    for (const session of [...active, ...idle]) {
      els.live.appendChild(renderCard(session));
    }

    const add = document.createElement('button');
    add.className = 'board-add';
    add.textContent = t('board.newAgent');
    add.addEventListener('click', () => onNewAgent());
    els.live.appendChild(add);
  }

  function renderCard(session) {
    const card = document.createElement('div');
    card.className = `board-card status-${session.status} accent-${session.color}`;

    const head = document.createElement('div');
    head.className = 'board-card-head';
    const dot = document.createElement('span');
    dot.className = `status-dot ${session.status}`;
    const title = document.createElement('span');
    title.className = 'board-card-title';
    title.textContent = session.title;
    const badge = document.createElement('span');
    badge.className = `board-badge ${session.status}`;
    badge.textContent = t(STATUS_LABEL[session.status] || 'board.idle');
    head.append(dot, title, badge);

    // What it's doing right now
    const activity = session.activity || {};
    const line = document.createElement('div');
    line.className = 'board-activity';
    if (session.status === 'running' || session.status === 'waiting') {
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      line.appendChild(spinner);
      const text = document.createElement('span');
      const step = activity.step ? ` · ${activity.step}/${activity.maxSteps}` : '';
      text.textContent = (activity.action || t('board.working')) + step;
      line.appendChild(text);
    } else {
      line.textContent = session.lastMessage || t('board.done');
    }
    card.append(head, line);

    // The page it's on — clickable to jump there
    if (activity.url) {
      const page = document.createElement('button');
      page.className = 'board-page';
      page.title = t('board.openTab');
      const favicon = document.createElement('img');
      favicon.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostOf(activity.url))}&sz=32`;
      favicon.alt = '';
      favicon.className = 'board-favicon';
      favicon.onerror = () => favicon.remove();
      const label = document.createElement('span');
      label.textContent = activity.page || hostOf(activity.url);
      page.append(favicon, label);
      // The summary carries no tabId, so the worker resolves the agent's tab.
      page.addEventListener('click', () => post({ type: 'focus_tab', sessionId: session.id }));
      card.appendChild(page);
    }

    // Footer: quick stats + open
    const foot = document.createElement('div');
    foot.className = 'board-foot';
    const stats = document.createElement('span');
    stats.className = 'board-stats-line';
    stats.textContent =
      t('board.cardStats', session.toolCount || 0, session.screenshotCount || 0) +
      (session.usage?.costUsd ? ` \u00b7 ${formatCost(session.usage.costUsd, getCurrency())}` : '');
    const open = document.createElement('button');
    open.className = 'board-open';
    open.textContent = t('board.open');
    open.addEventListener('click', () => onOpenSession(session.id));
    foot.append(stats, open);
    card.appendChild(foot);

    return card;
  }

  // ----------------------------------------------------------------- history

  function renderHistory(history) {
    els.history.innerHTML = '';
    els.historyEmpty.classList.toggle('hidden', history.length > 0);
    els.clear.classList.toggle('hidden', history.length === 0);

    for (const entry of history) {
      const row = document.createElement('div');
      row.className = `history-row status-${entry.status}`;

      const main = document.createElement('div');
      main.className = 'history-main';
      const title = document.createElement('div');
      title.className = 'history-title';
      title.textContent = entry.title;
      const sub = document.createElement('div');
      sub.className = 'history-sub';
      sub.textContent = entry.lastMessage || entry.firstTask || '';
      main.append(title, sub);

      const meta = document.createElement('div');
      meta.className = 'history-meta';
      const when = document.createElement('span');
      when.textContent = relTime(entry.endedAt || entry.createdAt);
      const tokens = document.createElement('span');
      tokens.className = 'history-tokens';
      tokens.textContent = entry.usage?.calls
        ? (entry.usage.costUsd ? `${formatCost(entry.usage.costUsd, getCurrency())} · ` : '') +
          t('board.historyTokens', entry.usage.calls, (entry.usage.input + entry.usage.output).toLocaleString(locale()))
        : '';
      meta.append(when, tokens);

      row.append(main, meta);
      els.history.appendChild(row);
    }
  }

  return {
    render({ sessions, history }) {
      if (sessions) renderLive(sessions);
      if (history) renderHistory(history);
    },
    renderLive,
    refresh: () => post({ type: 'board_get' }),
  };
}
