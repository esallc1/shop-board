/* ============================================================
   file-cabinet.js — the owner board's read-only "File Cabinet" tab.

   Renders the living wiring docs under /docs/wiring/*.md: a folder list on the
   left (one row per subsystem, with a status chip) and the selected doc,
   markdown-rendered, on the right. The README opens by default.

   HONESTY SIGNAL (the whole point): the status chip is NOT hardcoded — it is
   derived from each doc's own header line. "verified vs commit <hash>" → a green
   verified chip; "DRAFT" or "Needs review" → an amber chip. If a doc goes stale
   and someone flips its header back to DRAFT, the chip flips to amber on its own.

   READ-ONLY. Docs are edited by CC in the repo, never from the board. This is a
   static Vercel deploy (no runtime directory listing), so the set of docs comes
   from the DOCS manifest below; /docs/wiring/ is served as static files.

   Self-contained, same shape as shared/roadmap.js & shared/adoption.js: injects
   its own namespaced <style> (.fc-*) and exposes window.FileCabinet.init(config).
     const fc = FileCabinet.init({ mountSelector:'#filecabinet-root' });
     fc.refetch();   // re-pull the docs (used by the board's refresh safety net)
   No db, no session — nothing here is user-scoped.
   ============================================================ */

window.FileCabinet = (function () {
  'use strict';

  const BASE = '/docs/wiring/';

  // The docs, in display order. README is the intro/overview and opens first.
  // (A manifest, not a runtime listing — the static deploy can't enumerate a
  // directory. Keep this in sync with what's in /docs/wiring/.)
  const DOCS = [
    { id: 'readme',   file: 'README.md',            icon: '🗄️', title: 'Overview — the File Cabinet' },
    { id: 'comeback', file: 'comeback-warranty.md', icon: '🔁', title: 'Comeback / warranty' },
    { id: 'audio',    file: 'recordings-audio.md',  icon: '🎙️', title: 'Recordings / audio' },
    { id: 'customer', file: 'customer-record.md',   icon: '👤', title: 'Customer record' },
    { id: 'wizard',   file: 'intake-wizard.md',     icon: '🧾', title: 'Intake wizard (New RO flow)' },
    { id: 'floor',    file: 'floor-tags.md',        icon: '🚩', title: 'Floor tags & board lanes' },
    { id: 'calldesk', file: 'call-window-desk.md',  icon: '📞', title: 'Call window & Desk' },
    { id: 'announce', file: 'announcements.md',     icon: '📣', title: 'Announcement banner' },
    { id: 'checkin',  file: 'ro-checkin-tech.md',   icon: '🔧', title: 'RO check-in / tech assign' },
    { id: 'techboard', file: 'tech-board.md',       icon: '🔧', title: 'Tech Board (dispatcher)' },
    { id: 'mynumbers', file: 'my-numbers.md',       icon: '📱', title: 'My Numbers (tech phone tool)' },
    { id: 'flatrate',  file: 'flat-rate-hours.md',  icon: '📊', title: 'Flagged-hours / flat-rate data' },
    { id: 'settings',  file: 'settings.md',         icon: '⚙️', title: 'Settings hub (storage · roles · enforcement)' },
    { id: 'officeauth', file: 'office-auth.md',      icon: '🔐', title: 'Office auth (Supabase Auth adoption)' },
    { id: 'todo',     file: 'todo-list.md',         icon: '✅', title: 'To-Do list' },
    { id: 'requests', file: 'change-requests.md',   icon: '🚩', title: 'Requests & Feedback intake' },
    { id: 'cabinet',  file: 'file-cabinet.md',      icon: '🗄️', title: 'File Cabinet tab (this screen)' },
  ];
  const byFile = {}; DOCS.forEach(d => { byFile[d.file] = d; });

  // ── HTML escaping that PRESERVES real entities (docs contain literal &nbsp;) ──
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/&amp;(nbsp|amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, '&$1;');
  }

  // ── Status chip, DERIVED from the doc's header (never hardcoded) ──
  // Prefers the doc's "> Status:" line; falls back to scanning the header block.
  // "verified vs [commit] <hash>" → green; "DRAFT" / "Needs review" → amber.
  function deriveStatus(md) {
    const top = String(md || '').split('\n').slice(0, 16);
    const statusLine = top.find(l => /^\s*>?\s*Status\s*:/i.test(l)) || '';
    const VERIFIED = /verified vs (?:commit\s+)?`?([0-9a-f]{7,40})`?/i;
    const scan = statusLine || top.join('\n');
    let v = scan.match(VERIFIED);
    if (v) return { cls: 'ok', text: 'verified vs ' + v[1], dot: true };
    if (/\bDRAFT\b/i.test(scan)) return { cls: 'warn', text: 'DRAFT', dot: false };
    if (/needs review/i.test(scan)) return { cls: 'warn', text: 'Needs review', dot: false };
    if (statusLine) { v = top.join('\n').match(VERIFIED); if (v) return { cls: 'ok', text: 'verified vs ' + v[1], dot: true }; }
    return { cls: 'muted', text: 'unverified', dot: false };
  }

  // ── Inline markdown → HTML. Split on inline-code spans so their contents are
  // never touched by the emphasis/link passes (and never collide with digits —
  // no string sentinels). Odd segments are code, even segments are normal text.
  function inline(text) {
    const parts = String(text).split(/(`[^`]+`)/g);
    return parts.map((seg, idx) => {
      if (idx % 2 === 1) return `<code>${esc(seg.slice(1, -1))}</code>`;
      let s = esc(seg);
      // links [text](url): internal *.md → folder switch; http(s) → new tab; other → inert
      s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, url) => {
        const clean = url.trim();
        const mdLink = clean.match(/^([A-Za-z0-9._-]+)\.md(?:#.*)?$/);
        if (mdLink && byFile[mdLink[1] + '.md']) return `<a href="#" data-fc-doc="${esc(byFile[mdLink[1] + '.md'].id)}">${t}</a>`;
        if (/^https?:\/\//i.test(clean)) return `<a href="${esc(clean)}" target="_blank" rel="noopener noreferrer">${t}</a>`;
        return `<span>${t}</span>`;
      });
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
      s = s.replace(/(^|[^_A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/g, '$1<em>$2</em>');
      return s;
    }).join('');
  }

  const isBullet = (l) => /^\s*[-*]\s+/.test(l);
  const indentOf = (l) => (l.match(/^(\s*)/)[1] || '').length;

  // ── Block markdown → HTML ──
  function renderMarkdown(src) {
    const lines = String(src).replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // fenced code block ``` … ```
      if (/^```[a-zA-Z]*\s*$/.test(line)) {
        i++;
        const buf = [];
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // consume the closing fence
        html += `<pre class="fc-pre"><code>${esc(buf.join('\n'))}</code></pre>`;
        continue;
      }

      // blank line
      if (/^\s*$/.test(line)) { i++; continue; }

      // horizontal rule
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { html += '<hr class="fc-hr">'; i++; continue; }

      // heading
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { const lvl = h[1].length; html += `<h${lvl} class="fc-h fc-h${lvl}">${inline(h[2].trim())}</h${lvl}>`; i++; continue; }

      // table: header row followed by a |---|---| separator
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length &&
          /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].indexOf('-') !== -1) {
        const rows = [];
        while (i < lines.length && lines[i].indexOf('|') !== -1 && /^\s*\|.*\|?\s*$/.test(lines[i])) { rows.push(lines[i]); i++; }
        const cells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
        const head = cells(rows[0]);
        const body = rows.slice(2);
        html += '<div class="fc-table-wrap"><table class="fc-table"><thead><tr>' +
          head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
          body.map(r => '<tr>' + cells(r).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table></div>';
        continue;
      }

      // blockquote — one or more consecutive "> " lines (the doc header meta)
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        html += '<blockquote class="fc-quote">' + buf.map(b => `<div>${inline(b)}</div>`).join('') + '</blockquote>';
        continue;
      }

      // bulleted list — collect the block, merging wrapped continuation lines
      // (indented, no marker) into the current item; one level of nesting.
      if (isBullet(line)) {
        const items = [];
        while (i < lines.length) {
          const l = lines[i];
          if (isBullet(l)) { items.push({ indent: indentOf(l), text: l.replace(/^\s*[-*]\s+/, '') }); i++; }
          else if (/^\s+\S/.test(l) && items.length) { items[items.length - 1].text += ' ' + l.trim(); i++; }
          else break;
        }
        const base = Math.min.apply(null, items.map(it => it.indent));
        let out = '<ul class="fc-ul">', sub = false;
        for (const it of items) {
          if (it.indent > base) {
            if (!sub) { out += '<ul class="fc-ul fc-ul-sub">'; sub = true; }
            out += `<li>${inline(it.text)}</li>`;
          } else {
            if (sub) { out += '</ul>'; sub = false; }
            out += `<li>${inline(it.text)}</li>`;
          }
        }
        if (sub) out += '</ul>';
        out += '</ul>';
        html += out;
        continue;
      }

      // paragraph — gather until a blank line or a block boundary
      const para = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6})\s+/.test(lines[i]) &&
             !isBullet(lines[i]) && !/^\s*>\s?/.test(lines[i]) && !/^```/.test(lines[i]) &&
             !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      html += `<p>${inline(para.join(' '))}</p>`;
    }
    return html;
  }

  // ── One-time namespaced stylesheet ──
  function injectStyle() {
    if (document.querySelector('style[data-file-cabinet]')) return;
    const st = document.createElement('style');
    st.setAttribute('data-file-cabinet', '');
    st.textContent = `
    .fc-wrap { display:grid; grid-template-columns:300px 1fr; border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; background:var(--surface); height:calc(100vh - 150px); min-height:420px; }
    .fc-list { border-right:1px solid var(--border); background:var(--surface-2); overflow-y:auto; }
    .fc-list-head { padding:16px 16px 12px; border-bottom:1px solid var(--border); position:sticky; top:0; background:var(--surface-2); z-index:1; }
    .fc-list-title { font-size:0.95rem; font-weight:800; color:var(--text); }
    .fc-list-sub { font-size:0.72rem; color:var(--muted); margin-top:5px; line-height:1.45; }
    .fc-folders { padding:8px; }
    .fc-folder { display:flex; gap:10px; align-items:flex-start; padding:10px 11px; border-radius:9px; cursor:pointer; border:1px solid transparent; }
    .fc-folder:hover { background:var(--surface); }
    .fc-folder.active { background:var(--surface); border-color:var(--border); box-shadow:0 1px 2px rgba(20,25,50,.06); }
    .fc-ic { font-size:1.1rem; line-height:1.2; flex-shrink:0; }
    .fc-ft { flex:1; min-width:0; }
    .fc-fn { display:block; font-size:0.82rem; font-weight:600; color:var(--text); }
    .fc-folder.active .fc-fn { color:var(--accent); }
    .fc-fm { display:block; margin-top:4px; }
    .fc-chip { display:inline-flex; align-items:center; gap:5px; font-size:0.68rem; font-weight:600; padding:3px 8px; border-radius:999px; background:var(--surface); border:1px solid var(--border); color:var(--muted); }
    .fc-chip.ok { background:#e7f9f1; border-color:#a7f3d0; color:#047857; }
    .fc-chip.warn { background:#fef3c7; border-color:#fde68a; color:#b45309; }
    .fc-chip.muted { background:var(--surface-2); }
    .fc-dot { width:6px; height:6px; border-radius:50%; background:#047857; display:inline-block; }
    .fc-doc { overflow-y:auto; background:var(--bg); }
    .fc-doc-inner { max-width:820px; margin:0 auto; padding:24px 32px 72px; }
    .fc-crumb { font-size:0.72rem; color:var(--muted); margin-bottom:14px; }
    .fc-crumb b { color:var(--text); }
    .fc-doc-status { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:18px; }
    .fc-md { color:var(--text); font-size:0.86rem; line-height:1.62; }
    .fc-md .fc-h { line-height:1.3; }
    .fc-md .fc-h1 { font-size:1.5rem; font-weight:800; letter-spacing:-.3px; margin:2px 0 4px; }
    .fc-md .fc-h2 { font-size:1.05rem; font-weight:800; color:var(--text); margin:26px 0 8px; padding-top:4px; }
    .fc-md .fc-h3 { font-size:0.92rem; font-weight:700; color:var(--text); margin:20px 0 6px; }
    .fc-md .fc-h4, .fc-md .fc-h5, .fc-md .fc-h6 { font-size:0.86rem; font-weight:700; margin:16px 0 6px; }
    .fc-md p { margin:0 0 11px; }
    .fc-md ul.fc-ul { margin:0 0 12px; padding:0; list-style:none; }
    .fc-md ul.fc-ul-sub { margin:6px 0 2px 6px; }
    .fc-md ul.fc-ul li { position:relative; padding-left:18px; margin-bottom:7px; }
    .fc-md ul.fc-ul li:before { content:"▸"; position:absolute; left:2px; color:var(--accent); }
    .fc-md a { color:var(--accent); text-decoration:none; border-bottom:1px solid transparent; cursor:pointer; }
    .fc-md a:hover { border-bottom-color:var(--accent); }
    .fc-md code { background:var(--surface-2); border:1px solid var(--border); padding:1px 5px; border-radius:5px; font-size:0.8rem; font-family:"SF Mono",ui-monospace,Menlo,monospace; color:#3a2b6b; overflow-wrap:anywhere; }
    .fc-md pre.fc-pre { background:#0f1426; color:#d6dbf5; padding:14px 16px; border-radius:10px; overflow-x:auto; margin:0 0 14px; }
    .fc-md pre.fc-pre code { background:none; border:none; color:inherit; padding:0; font-size:0.78rem; }
    .fc-md blockquote.fc-quote { border-left:3px solid var(--border); background:var(--surface); margin:0 0 16px; padding:10px 14px; border-radius:0 8px 8px 0; color:var(--muted); font-size:0.8rem; }
    .fc-md blockquote.fc-quote div { margin:1px 0; }
    .fc-md .fc-hr { border:none; border-top:1px solid var(--border); margin:20px 0; }
    .fc-md .fc-table-wrap { overflow-x:auto; margin:0 0 16px; }
    .fc-md table.fc-table { border-collapse:collapse; width:100%; font-size:0.8rem; }
    .fc-md table.fc-table th, .fc-md table.fc-table td { border:1px solid var(--border); padding:7px 10px; text-align:left; vertical-align:top; }
    .fc-md table.fc-table th { background:var(--surface-2); font-weight:700; }
    .fc-empty, .fc-err { color:var(--muted); font-size:0.85rem; padding:24px; }
    .fc-err { color:var(--red); }
    @media (max-width:768px) {
      .fc-wrap { grid-template-columns:1fr; height:auto; }
      .fc-list { border-right:none; border-bottom:1px solid var(--border); max-height:300px; }
      .fc-doc-inner { padding:18px 16px 56px; }
    }
    `;
    document.head.appendChild(st);
  }

  const SHELL =
    '<div class="fc-wrap">' +
      '<div class="fc-list">' +
        '<div class="fc-list-head">' +
          '<div class="fc-list-title">🗄️ File Cabinet</div>' +
          '<div class="fc-list-sub">Living docs — how CrisData is actually wired. One folder per subsystem, rewritten in place. Read-only.</div>' +
        '</div>' +
        '<div class="fc-folders" id="fc-folders"></div>' +
      '</div>' +
      '<div class="fc-doc" id="fc-doc"><div class="fc-doc-inner" id="fc-doc-inner"><div class="fc-empty">Loading…</div></div></div>' +
    '</div>';

  function init(config) {
    injectStyle();
    const mount = document.querySelector(config.mountSelector);
    if (!mount) { console.error('[FileCabinet] mount not found:', config.mountSelector); return { refetch: function () {} }; }
    mount.innerHTML = SHELL;
    const foldersEl = mount.querySelector('#fc-folders');
    const docEl = mount.querySelector('#fc-doc');
    const docInner = mount.querySelector('#fc-doc-inner');

    const cache = {};   // id -> { md, status } | { error }
    let active = 'readme';

    function renderFolders() {
      foldersEl.innerHTML = DOCS.map(d => {
        const c = cache[d.id];
        const status = c && c.status ? c.status : { cls: 'muted', text: c && c.error ? 'unavailable' : '…', dot: false };
        return `<div class="fc-folder${d.id === active ? ' active' : ''}" data-fc-id="${d.id}">` +
          `<span class="fc-ic">${d.icon}</span>` +
          `<span class="fc-ft"><span class="fc-fn">${esc(d.title)}</span>` +
          `<span class="fc-fm"><span class="fc-chip ${status.cls}">${status.dot ? '<span class="fc-dot"></span>' : ''}${esc(status.text)}</span></span></span>` +
        `</div>`;
      }).join('');
      foldersEl.querySelectorAll('[data-fc-id]').forEach(el =>
        el.addEventListener('click', () => show(el.dataset.fcId)));
    }

    function show(id) {
      const doc = DOCS.find(d => d.id === id) || DOCS[0];
      active = doc.id;
      renderFolders();
      const c = cache[doc.id];
      if (!c) { docInner.innerHTML = '<div class="fc-empty">Loading…</div>'; }
      else if (c.error) { docInner.innerHTML = `<div class="fc-err">Couldn’t load <code>${esc(BASE + doc.file)}</code> — ${esc(c.error)}</div>`; }
      else {
        const s = c.status;
        docInner.innerHTML =
          `<div class="fc-crumb">🗄️ File Cabinet › <b>${esc(doc.title)}</b></div>` +
          `<div class="fc-doc-status">` +
            `<span class="fc-chip ${s.cls}">${s.dot ? '<span class="fc-dot"></span>' : ''}${esc(s.text)}</span>` +
            `<span class="fc-chip muted">📄 ${esc(BASE + doc.file)}</span>` +
          `</div>` +
          `<div class="fc-md">${renderMarkdown(c.md)}</div>`;
        docInner.querySelectorAll('[data-fc-doc]').forEach(a =>
          a.addEventListener('click', (e) => { e.preventDefault(); show(a.dataset.fcDoc); }));
      }
      docEl.scrollTop = 0;
    }

    async function load() {
      await Promise.all(DOCS.map(async (d) => {
        try {
          const r = await fetch(BASE + d.file, { cache: 'no-cache' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const md = await r.text();
          cache[d.id] = { md, status: deriveStatus(md) };
        } catch (e) {
          cache[d.id] = { error: (e && e.message) || 'fetch failed' };
        }
      }));
      renderFolders();
      show(active);
    }

    renderFolders();
    load();

    return { refetch: load };
  }

  return { init };
})();
