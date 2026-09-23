/* ============================================================
   global-search.js — the advisor board's top-bar search + "+ New RO".
   Wiring: docs/wiring/global-search.md. Rules: shared/global-search-logic.js.

   Mounted ONCE into .view-topbar (above every view, so on every advisor tab):
     [☰] [Title] [🔍 Search name, phone, plate, VIN, RO # or call notes] [+ New RO] [🚩 Report a change]
   Finds customers (from the board's own honest list cache —
   window.cdEnsureCustList, archive-filtered), vehicles (plate / VIN), ROs (ro_number or po)
   and old call notes (calls.note / outcome_note, every word). Reads ONLY, with
   the board's own client and the viewer's session — no endpoint, no writes.

   Results open through the board's own functions: cdOpenCustomerById, cdOpenRo,
   cdOpenCustomerAtCall (record, that call highlighted), cdDeskOpenLogAt (the
   call log on that call's day, highlighted). An unattached call never opens a
   guessed customer. "+ New RO" = window.cdOpenNewRo (the same wizard).

   Keys: "/" focuses the box (never while typing elsewhere); ↑/↓ walk the
   results; Enter opens; Esc closes. 200 ms debounce; a newer query always wins.
   ============================================================ */
import {
  classifyQuery, groupOrder, searchCustomerList, vehicleOr, roOr, callOrs,
  noteSnippet, roLabel, destination, flattenGroups, moveSelection, GROUP_LABELS,
} from './global-search-logic.js';
import { isTypingTarget } from './desk-pad-logic.js';

const DEBOUNCE_MS = 200;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fmtPhone = (p) => (typeof window.formatPhone === 'function' ? window.formatPhone(p) : p) || '';
const custLabel = (c) => (c && ((c.business_name && c.business_name.trim()) || c.name)) || 'Customer';
const vehDesc = (v) => [v.year, v.make, v.model].filter(Boolean).join(' ');

export function mountGlobalSearch({ db }) {
  const bar = document.querySelector('.view-topbar');
  if (!db || !bar || document.getElementById('gsearch')) return null;

  const wrap = document.createElement('div');
  wrap.className = 'gsearch';
  wrap.id = 'gsearch';
  wrap.innerHTML = `
    <div class="gsearch-box">
      <span class="gsearch-icon" aria-hidden="true">🔍</span>
      <input type="search" id="gsearchInput" autocomplete="off" spellcheck="false"
        placeholder="Search name, phone, plate, VIN, RO # or call notes"
        aria-label="Search customers, vehicles, ROs and call notes" role="combobox"
        aria-expanded="false" aria-controls="gsearchList" aria-autocomplete="list">
      <span class="gsearch-kbd" aria-hidden="true">/</span>
    </div>
    <div class="gsearch-list" id="gsearchList" role="listbox" hidden></div>`;
  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'gsearch-new btn btn-primary';
  newBtn.id = 'topNewRoBtn';
  newBtn.textContent = '+ New RO';
  newBtn.addEventListener('click', () => { closeList(); if (window.cdOpenNewRo) window.cdOpenNewRo(); });

  const report = bar.querySelector('.rc-launch');
  if (report) { bar.insertBefore(wrap, report); bar.insertBefore(newBtn, report); }
  else { bar.appendChild(wrap); bar.appendChild(newBtn); }

  const input = wrap.querySelector('#gsearchInput');
  const list = wrap.querySelector('#gsearchList');

  let seq = 0, timer = null;
  let flat = [], sel = -1, lastCls = null;
  let custCache = null;

  // Customers come from the BOARD's own list cache (window.cdEnsureCustList: the
  // Customers tab's cache — invalidated on every customer write, realtime-refreshed,
  // stale-while-revalidate, archive-filtered). Never a private copy that could miss
  // a customer created a minute ago. A list that failed to load THROWS, so the
  // dropdown says "Couldn't search Customers" — never "No matches".
  async function customers() {
    let rows = null;
    if (typeof window.cdEnsureCustList === 'function') rows = await window.cdEnsureCustList();
    else if (typeof window.cdFetchAllCustomers === 'function') rows = await window.cdFetchAllCustomers();
    if (!Array.isArray(rows) || (!rows.length && window.cdCustFetchError)) {
      throw new Error('customer list not loaded' + (window.cdCustFetchError ? ': ' + window.cdCustFetchError : ''));
    }
    custCache = rows;
    return rows;
  }
  const custById = (id) => (custCache || []).find((c) => String(c.id) === String(id)) || null;

  /* ── the four searches ───────────────────────────────────────────────── */
  async function runSearch(q) {
    const my = ++seq;
    const cls = classifyQuery(q);
    lastCls = cls;
    if (!cls.customers && !cls.vehicles && !cls.ros && !cls.calls) { closeList(); return; }
    renderLoading();

    const tasks = {
      customer: customers().then((all) => searchCustomerList(all, cls)),
      vehicle: (async () => {
        const f = vehicleOr(cls); if (!f) return [];
        const r = await db.from('vehicles')
          .select('id, year, make, model, plate, vin, customer_id, owner:customers(id, name, business_name, archived_at, merged_into)')
          .or(f).limit(8);
        if (r.error) throw r.error;
        return r.data || [];
      })(),
      ro: (async () => {
        const f = roOr(cls); if (!f) return [];
        const r = await db.from('repair_orders')
          .select('id, ro_number, po, status, customers(name, business_name), vehicles(year, make, model)')
          .or(f).order('ro_number', { ascending: false, nullsFirst: false }).limit(8);
        if (r.error) throw r.error;
        return r.data || [];
      })(),
      call: (async () => {
        const ors = callOrs(cls); if (!ors.length) return [];
        let qb = db.from('calls').select('id, started_at, created_at, note, outcome_note, customer_id, caller_bare, caller_formatted');
        for (const o of ors) qb = qb.or(o);                 // every word must appear
        const r = await qb.order('started_at', { ascending: false, nullsFirst: false }).limit(8);
        if (r.error) throw r.error;
        return r.data || [];
      })(),
    };
    const groups = {}, errors = [];
    await Promise.all(Object.entries(tasks).map(([k, p]) => p.then((v) => { groups[k] = v; })
      .catch((e) => { groups[k] = []; errors.push(GROUP_LABELS[k]); console.warn('[GlobalSearch] ' + k + ' search failed', e); })));
    if (my !== seq) return;                                  // a newer query already answered
    render(groups, cls, errors);
  }

  /* ── drawing ─────────────────────────────────────────────────────────── */
  function openList() { list.hidden = false; input.setAttribute('aria-expanded', 'true'); }
  function closeList() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); sel = -1; }
  function renderLoading() { if (list.hidden || !flat.length) { list.innerHTML = '<div class="gsearch-note">Searching…</div>'; openList(); } }

  function lineFor(kind, x) {
    if (kind === 'customer') {
      const phone = x.phone_primary || x.phone_secondary;
      return { title: custLabel(x), sub: [x.business_name && x.name ? x.name : '', phone ? fmtPhone(phone) : ''].filter(Boolean).join(' · ') };
    }
    if (kind === 'vehicle') {
      const owner = x.owner ? custLabel(x.owner) : 'No owner on file';
      const ids = [x.plate ? `Plate ${x.plate}` : '', x.vin ? `VIN ${x.vin}` : ''].filter(Boolean).join(' · ');
      return { title: vehDesc(x) || 'Vehicle', sub: [ids, owner].filter(Boolean).join(' — ') };
    }
    if (kind === 'ro') {
      const c = x.customers ? custLabel(x.customers) : '';
      const v = x.vehicles ? vehDesc(x.vehicles) : '';
      return { title: roLabel(x), sub: [c, v, x.status].filter(Boolean).join(' · ') };
    }
    const who = x.customer_id ? custLabel(custById(x.customer_id)) : (x.caller_formatted || fmtPhone(x.caller_bare) || 'Unknown caller');
    const when = x.started_at ? new Date(x.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }) : '';
    const text = [x.note, x.outcome_note].filter(Boolean).join(' — ');
    return { title: noteSnippet(text, lastCls ? lastCls.words : []), sub: [who + (x.customer_id ? '' : ' (not attached)'), when].filter(Boolean).join(' · ') };
  }

  function render(groups, cls, errors) {
    const order = groupOrder(cls);
    flat = flattenGroups(groups, order);
    sel = flat.length ? 0 : -1;
    if (!flat.length) {
      list.innerHTML = `<div class="gsearch-note">${errors.length ? `Couldn't search ${esc(errors.join(', '))} just now.` : 'No matches.'}</div>`;
      openList(); return;
    }
    let i = 0, html = '';
    for (const kind of order) {
      const items = flat.filter((f) => f.kind === kind);
      if (!items.length) continue;
      html += `<div class="gsearch-group" role="presentation">${esc(GROUP_LABELS[kind])}</div>`;
      for (const f of items) {
        const l = lineFor(kind, f.item);
        html += `<button type="button" class="gsearch-item" role="option" data-i="${i}" id="gsearchOpt${i}" aria-selected="false">
          <span class="gsearch-t">${esc(l.title)}</span><span class="gsearch-s">${esc(l.sub)}</span></button>`;
        i++;
      }
    }
    if (errors.length) html += `<div class="gsearch-note">Couldn't search ${esc(errors.join(', '))} just now.</div>`;
    list.innerHTML = html;
    openList();
    paintSel();
  }

  function paintSel() {
    list.querySelectorAll('.gsearch-item').forEach((b) => {
      const on = Number(b.dataset.i) === sel;
      b.classList.toggle('is-sel', on);
      b.setAttribute('aria-selected', String(on));
      if (on) b.scrollIntoView({ block: 'nearest' });
    });
    input.setAttribute('aria-activedescendant', sel >= 0 ? 'gsearchOpt' + sel : '');
  }

  /* ── opening a result ────────────────────────────────────────────────── */
  function go(i) {
    const f = flat[i]; if (!f) return;
    const CA = window.CustomerArchive;
    const d = destination(f.kind, f.item, { mergedIntoId: CA && CA.mergedIntoId });
    closeList();
    input.blur();
    if (d.to === 'customer' && window.cdOpenCustomerById) window.cdOpenCustomerById(d.id);
    else if (d.to === 'ro' && window.cdOpenRo) {
      const nav = document.querySelector('.sidebar-item[data-view="cdros"]'); if (nav) nav.click();
      window.cdOpenRo(d.id);
    } else if (d.to === 'customer-call' && window.cdOpenCustomerAtCall) window.cdOpenCustomerAtCall(d.id, d.callId);
    else if (d.to === 'call-log' && window.cdDeskOpenLogAt) window.cdDeskOpenLogAt(d.when, d.callId);
    else if (d.to === 'desk') { const nav = document.querySelector('.sidebar-item[data-view="desk"]'); if (nav) nav.click(); }
  }

  /* ── events ──────────────────────────────────────────────────────────── */
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value;
    if (!q.trim()) { seq++; closeList(); list.innerHTML = ''; flat = []; return; }
    timer = setTimeout(() => runSearch(q), DEBOUNCE_MS);
  });
  input.addEventListener('focus', () => { customers().catch(() => {}); if (input.value.trim() && flat.length) openList(); });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (list.hidden && flat.length) openList();
      sel = moveSelection(sel, ev.key === 'ArrowDown' ? 1 : -1, flat.length);
      paintSel(); ev.preventDefault();
    } else if (ev.key === 'Enter') {
      if (sel >= 0) { ev.preventDefault(); go(sel); }
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      if (!list.hidden) closeList(); else { input.value = ''; input.blur(); }
    }
  });
  list.addEventListener('mousedown', (ev) => ev.preventDefault());   // keep focus while clicking a result
  list.addEventListener('click', (ev) => { const b = ev.target.closest('.gsearch-item'); if (b) go(Number(b.dataset.i)); });
  document.addEventListener('click', (ev) => { if (!wrap.contains(ev.target)) closeList(); });

  // "/" focuses the box — never while typing in another field.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey || ev.defaultPrevented) return;
    if (isTypingTarget(document.activeElement) || isTypingTarget(ev.target)) return;
    ev.preventDefault();
    input.focus();
    input.select();
  });

  const api = {
    // Open the box with a query already typed (e.g. an ambiguous phone from the Desk).
    open(q) {
      input.value = q == null ? '' : String(q);
      input.focus();
      if (input.value.trim()) runSearch(input.value);
    },
  };
  window.cdGlobalSearch = api;
  return api;
}
