// Knowledge tab: list/add/pin/delete documents, drag-and-drop file import,
// and the bug-report exporter. Self-contained view module — panel.js only
// initializes it and forwards worker messages, part of splitting the panel
// into per-view modules instead of one growing controller.

import { t, locale } from '../ui/i18n.js';
import { icon, iconButton } from '../ui/icons.js';

const MAX_FILE_BYTES = 400_000;
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|log|ya?ml|html?|xml)$/i;

export function createKnowledgeView({ post }) {
  const $ = (id) => document.getElementById(id);
  const els = {
    list: $('kb-list'),
    drop: $('drop-zone'),
    file: $('kb-file'),
    pick: $('kb-pick'),
    name: $('kb-name'),
    text: $('kb-text'),
    pinned: $('kb-pinned'),
    save: $('kb-save'),
    status: $('kb-status'),
    bugExport: $('bug-export'),
    bugClear: $('bug-clear'),
    bugStatus: $('bug-status'),
  };

  function setStatus(el, text, ok = true) {
    el.textContent = text;
    el.className = `setup-status ${ok ? 'ok' : 'err'}`;
    setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 4000);
  }

  // ------------------------------------------------------------------ render

  function render({ docs, diagnostics }) {
    els.list.innerHTML = '';

    if (!docs.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = t('kb.empty');
      els.list.appendChild(empty);
    }

    for (const doc of docs) {
      const row = document.createElement('div');
      row.className = 'kb-row';

      const info = document.createElement('div');
      info.className = 'kb-info';
      const name = document.createElement('div');
      name.className = 'kb-name';
      name.appendChild(icon(doc.kind === 'note' ? 'note' : 'file', { size: 14 }));
      name.appendChild(document.createTextNode(` ${doc.name}`));
      const meta = document.createElement('div');
      meta.className = 'kb-meta';
      meta.textContent =
        t('kb.chars', doc.chars.toLocaleString(locale())) + (doc.pinned ? ` \u00b7 ${t('kb.pinned')}` : '');
      info.append(name, meta);

      const actions = document.createElement('div');
      actions.className = 'r-actions';
      const pin = document.createElement('button');
      pin.className = 'icon-btn';
      pin.appendChild(icon('pin', { size: 14 }));
      pin.title = t(doc.pinned ? 'kb.unpin' : 'kb.pin');
      pin.addEventListener('click', () =>
        post({ type: 'knowledge_update', id: doc.id, patch: { pinned: !doc.pinned } })
      );
      const del = document.createElement('button');
      del.className = 'icon-btn';
      del.appendChild(icon('trash', { size: 14 }));
      del.title = t('kb.delete');
      del.addEventListener('click', () => {
        if (confirm(t('kb.deleteConfirm', doc.name))) post({ type: 'knowledge_delete', id: doc.id });
      });
      actions.append(pin, del);

      row.append(info, actions);
      els.list.appendChild(row);
    }

    setBugCount(diagnostics);
  }

  function setBugCount(count) {
    els.bugStatus.textContent = count ? t('kb.bugCount', count) : t('kb.bugNone');
    els.bugStatus.className = 'setup-status';
  }

  // ------------------------------------------------------------------- files

  async function importFiles(fileList) {
    for (const file of fileList) {
      if (!TEXT_EXTENSIONS.test(file.name) && !file.type.startsWith('text/')) {
        setStatus(els.status, `${file.name}: ${t('kb.formats')}`, false);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        setStatus(els.status, `${file.name}: too large`, false);
        continue;
      }
      const text = await file.text();
      post({ type: 'knowledge_add', doc: { name: file.name, text, kind: 'file' } });
      setStatus(els.status, t('kb.added', file.name));
    }
  }

  els.pick.addEventListener('click', () => els.file.click());
  els.file.addEventListener('change', () => {
    importFiles([...els.file.files]);
    els.file.value = '';
  });

  els.drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    els.drop.classList.add('over');
  });
  els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
  els.drop.addEventListener('drop', (event) => {
    event.preventDefault();
    els.drop.classList.remove('over');
    if (event.dataTransfer?.files?.length) importFiles([...event.dataTransfer.files]);
  });

  // ------------------------------------------------------------------- notes

  els.save.addEventListener('click', () => {
    const text = els.text.value.trim();
    if (!text) return setStatus(els.status, t('routines.needTask'), false);
    post({
      type: 'knowledge_add',
      doc: {
        name: els.name.value.trim() || text.slice(0, 40),
        text,
        kind: 'note',
        pinned: els.pinned.checked,
      },
    });
    if (els.pinned.checked && text.length > 2000) setStatus(els.status, t('kb.pinTooLong'));
    else setStatus(els.status, t('kb.added', els.name.value.trim() || text.slice(0, 20)));
    els.name.value = '';
    els.text.value = '';
    els.pinned.checked = false;
  });

  // -------------------------------------------------------------- bug report

  els.bugExport.addEventListener('click', () => post({ type: 'bug_report' }));
  els.bugClear.addEventListener('click', () => {
    post({ type: 'diagnostics_clear' });
    setStatus(els.bugStatus, t('kb.bugCleared'));
  });

  function downloadReport(markdown) {
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `openagent-bug-report-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  return {
    render,
    downloadReport,
    refresh: () => post({ type: 'knowledge_get' }),
  };
}
