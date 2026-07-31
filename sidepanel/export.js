// Session export: builds a downloadable JSON dump or a self-contained HTML
// report (chat + every tool call + embedded screenshots), then saves it.
// Runs in the panel because service workers have no URL.createObjectURL.

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function slugify(text) {
  return (text || 'session')
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'session';
}

export function exportJson(payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  download(`openagent-${slugify(payload.title)}.json`, blob);
}

function renderEvent(event) {
  const time = new Date(event.at).toLocaleTimeString();

  switch (event.kind) {
    case 'user':
      return `<div class="msg user"><div class="meta">You · ${time}</div><div class="body">${escapeHtml(event.text)}</div></div>`;

    case 'assistant':
      return `<div class="msg assistant"><div class="meta">Agent · ${time}</div><div class="body">${escapeHtml(event.text)}</div></div>`;

    case 'tool': {
      if (event.state === 'running') return '';
      const image = event.imageDataUrl
        ? `<img src="${escapeHtml(event.imageDataUrl)}" alt="screenshot taken by the agent" />`
        : '';
      return `<details class="tool ${escapeHtml(event.state)}">
  <summary><code>${escapeHtml(event.name)}</code> — ${escapeHtml(event.summary || event.state)} <span class="meta">${time}</span></summary>
  <pre class="args">${escapeHtml(JSON.stringify(event.input || {}, null, 2))}</pre>
  ${event.detail ? `<pre class="out">${escapeHtml(event.detail)}</pre>` : ''}
  ${image}
</details>`;
    }

    case 'error':
      return `<div class="msg error"><div class="meta">Error · ${time}</div><div class="body">${escapeHtml(event.text)}</div></div>`;

    case 'system':
      return `<div class="note">${escapeHtml(event.text)} · ${time}</div>`;

    default:
      return '';
  }
}

export function exportHtml(payload) {
  const screenshots = (payload.artifacts || []).filter((a) => a.dataUrl);
  const gallery = screenshots.length
    ? `<h2>Screenshots (${screenshots.length})</h2>
       <div class="gallery">${screenshots
         .map((a) => `<figure><img src="${escapeHtml(a.dataUrl)}" alt="agent screenshot" /><figcaption>${escapeHtml(a.note || '')}</figcaption></figure>`)
         .join('')}</div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<title>OpenAgent — ${escapeHtml(payload.title)}</title>
<style>
 :root{--bg:#0f1115;--card:#171a21;--border:#2a2f3a;--text:#e8eaf0;--dim:#9aa1b0;--accent:#7c6cf5;--ok:#34c98e;--err:#f06a6a}
 @media(prefers-color-scheme:light){:root{--bg:#f7f7fa;--card:#fff;--border:#dfe2ea;--text:#1c1f27;--dim:#667085}}
 *{box-sizing:border-box}
 body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);margin:0;padding:32px 16px;line-height:1.55}
 main{max-width:820px;margin:0 auto}
 h1{font-size:22px;margin:0 0 4px}
 .sub{color:var(--dim);font-size:13px;margin-bottom:22px}
 .stats{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:26px}
 .stat{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-size:12px;color:var(--dim)}
 .stat b{color:var(--text)}
 .msg{border-radius:10px;padding:10px 14px;margin:10px 0;border:1px solid var(--border);background:var(--card)}
 .msg.user{background:var(--accent);border-color:var(--accent);color:#fff}
 .msg.user .meta{color:rgba(255,255,255,.8)}
 .msg.error{border-color:var(--err);color:var(--err)}
 .meta{font-size:11px;color:var(--dim);margin-bottom:5px}
 .body{white-space:pre-wrap;word-wrap:break-word}
 .note{color:var(--dim);font-size:12px;text-align:center;margin:10px 0}
 details.tool{border:1px solid var(--border);border-radius:8px;background:var(--card);margin:8px 0;font-size:13px}
 details.tool summary{cursor:pointer;padding:8px 12px;color:var(--dim)}
 details.tool.error summary{color:var(--err)}
 details.tool code{color:var(--text)}
 pre{white-space:pre-wrap;word-break:break-word;font-size:11.5px;color:var(--dim);background:var(--bg);margin:0;padding:10px 12px;border-top:1px solid var(--border);max-height:320px;overflow:auto}
 img{max-width:100%;border-top:1px solid var(--border);display:block}
 .gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
 figure{margin:0;background:var(--card);border:1px solid var(--border);border-radius:8px;overflow:hidden}
 figure img{border:0}
 figcaption{font-size:11px;color:var(--dim);padding:6px 8px}
 h2{font-size:16px;margin:32px 0 12px;border-top:1px solid var(--border);padding-top:22px}
</style></head>
<body><main>
<h1>${escapeHtml(payload.title)}</h1>
<div class="sub">OpenAgent session · started ${escapeHtml(new Date(payload.createdAt).toLocaleString())} · exported ${escapeHtml(new Date(payload.exportedAt).toLocaleString())}</div>
<div class="stats">
  <div class="stat">Steps: <b>${(payload.events || []).filter((e) => e.kind === 'tool' && e.state !== 'running').length}</b></div>
  <div class="stat">Model calls: <b>${payload.usage?.calls || 0}</b></div>
  <div class="stat">Tokens in: <b>${payload.usage?.input || 0}</b></div>
  <div class="stat">Tokens out: <b>${payload.usage?.output || 0}</b></div>
  <div class="stat">Screenshots: <b>${screenshots.length}</b></div>
</div>
${(payload.events || []).map(renderEvent).join('\n')}
${gallery}
</main></body></html>`;

  download(`openagent-${slugify(payload.title)}.html`, new Blob([html], { type: 'text/html' }));
}
