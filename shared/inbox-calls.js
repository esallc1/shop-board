/* ============================================================
   inbox-calls.js — incoming calls INSIDE the Inbox tray (slice 1).
   Wiring: docs/wiring/inbox-calls.md. Rules: shared/inbox-calls-logic.js.

   The call card is still built, wired and saved by the callerCard code in
   advisor-board.html — the SAME card and the SAME writes (direct `calls`
   updates; temporary until the security slice moves them to api/calls.js).
   This module only decides WHERE each card sits inside the tray's calls area:

     ring   — the pinned caller-ID GLANCE (mockup screen 1): the newest call
              still ringing (RING_MS after it started) that nobody opened yet —
              name, phone, vehicle, In shop now, Last visit, Heads up, and
              "Answered → notepad" (opens the card; the call stops pinning);
     rows   — "Needs handling": every other call on this board — NO NOTE YET on
              top, then noted ones (newest first each). Click → that card opens;
     detail — the one card opened (screen 2: recording, note, next step, …),
              with "‹ All" to put it back;
     store  — a hidden holder for the cards themselves (all of them, except the
              one open in the detail view).

   Cards are MOVED between these holders, never rebuilt, so a typed note, the
   chosen step and every listener survive. A card is gone when the card's own
   × / Close removes it (unchanged callerCard behaviour). A card with the
   keyboard focus inside it is never moved by the timer (no yanking a note
   someone is typing). Nothing here reads or writes the database.
   ============================================================ */
import {
  ringStartMs, isRinging, pickRinging, orderNeedsHandling, callRowName, callRowStatus, stripCalls, callerGlance,
} from './inbox-calls-logic.js';

const TICK_MS = 5000;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// section: the tray's calls area. onChange({ added }) after anything changed.
// timeLabel(iso): the tray's short time. Returns the tray-side API.
export function mountCallSlot({ section, onChange, timeLabel }) {
  section.innerHTML = `
    <div class="mtray-ring" aria-label="Ringing"></div>
    <div class="mtray-calldetail" hidden>
      <div class="mtray-calldetail-head"><button type="button" class="mtray-iconbtn" data-call-act="back">‹ All</button></div>
      <div class="mtray-calldetail-slot"></div>
    </div>
    <div class="mtray-callrows"></div>
    <div class="mtray-callstore" hidden></div>`;
  const ring = section.querySelector('.mtray-ring');
  const detail = section.querySelector('.mtray-calldetail');
  const detailSlot = section.querySelector('.mtray-calldetail-slot');
  const rows = section.querySelector('.mtray-callrows');
  const store = section.querySelector('.mtray-callstore');

  const cards = () => [...section.querySelectorAll('.call-card')];
  const entry = (card) => ({
    id: card.dataset.callId,
    startMs: Number(card.dataset.ringStart) || 0,
    inDetail: detailSlot.contains(card),
    answered: card.dataset.answered === '1',
    noted: !!card._noted,
    card,
  });
  const numberOf = (call) => call.caller_formatted
    || (typeof window.formatPhone === 'function' ? window.formatPhone(call.caller_bare) : call.caller_bare) || '';
  function glanceOf(card) {
    const call = card._call || {};
    const chip = card.querySelector('.call-card-chip');
    return callerGlance({ call, number: numberOf(call), source: chip ? chip.textContent : '', ...(card._glanceData || { state: 'loading' }) });
  }
  const hasFocus = (card) => card.contains(document.activeElement);

  function rowHtml(e, nowMs) {
    const c = e.card;
    const call = c._call || {};
    const g = glanceOf(c);
    const name = callRowName({ customerName: g.who !== 'New caller' ? g.who : '', cnam: call.cnam, number: g.phone });
    const ringing = isRinging(e.startMs, nowMs) && !e.answered;
    const when = typeof timeLabel === 'function' && call.started_at ? timeLabel(call.started_at, nowMs) : '';
    return `<button type="button" class="mtray-row mtray-callrow${ringing ? ' is-ringing' : ''}${e.noted ? '' : ' is-unnoted'}" data-call-row="${esc(e.id)}">
      <div class="mtray-row-top"><span class="mtray-name">📞 ${esc(name)}</span><span class="mtray-time">${esc(when)}</span></div>
      <div class="mtray-preview">${esc(callRowStatus({ source: g.source, ringing, noted: e.noted }))}</div>
    </button>`;
  }

  // The pinned caller-ID glance (screen 1) — built from the card's own data.
  function ringHtml(e) {
    const g = glanceOf(e.card);
    const line = (k, v) => `<div class="mtray-rg-ln"><span class="k">${k}</span><span>${esc(v)}</span></div>`;
    return `<div class="mtray-ringcard" role="status" data-ring-call="${esc(e.id)}">
      <div class="mtray-rg-top"><span class="mtray-rg-live">● Incoming · ${esc(g.source || 'call')}</span>${g.tag ? `<span class="mtray-rg-tag">${esc(g.tag)}</span>` : ''}</div>
      <div class="mtray-rg-who">${esc(g.who)}</div>
      <div class="mtray-rg-sub">${esc([g.phone !== g.who ? g.phone : '', g.sub].filter(Boolean).join(' · '))}</div>
      ${g.vehicle ? line('Vehicle', g.vehicle) : ''}
      ${line('In shop now', g.inShop || '—')}
      ${line('Last visit', g.lastVisit || '—')}
      ${line('Heads up', g.headsUp || 'None')}
      <div class="mtray-rg-acts">
        <button type="button" class="mtray-iconbtn is-primary" data-call-act="answer" data-call-id="${esc(e.id)}">Answered → notepad</button>
        ${g.customerId != null ? `<button type="button" class="mtray-iconbtn" data-call-act="customer" data-customer-id="${esc(g.customerId)}">Customer record</button>` : ''}
      </div>
    </div>`;
  }

  function openCard(card) {
    const cur = detailSlot.querySelector('.call-card');
    if (cur && cur !== card) store.appendChild(cur);
    card.dataset.answered = '1';           // opened = answered: it stops pinning
    detailSlot.appendChild(card);
    arrange();
    card.dispatchEvent(new CustomEvent('cc:shown'));   // the card loads its recording
    if (typeof onChange === 'function') onChange({});
  }

  // Put every card where it belongs, then redraw the glance + the rows.
  function arrange() {
    const nowMs = Date.now();
    const list = cards().map(entry);
    for (const e of list) {
      if (!e.inDetail && e.card.parentElement !== store && !hasFocus(e.card)) store.appendChild(e.card);
    }
    const ringId = pickRinging(list, nowMs);
    const ringE = ringId ? list.find((e) => e.id === ringId) : null;
    ring.innerHTML = ringE ? ringHtml(ringE) : '';
    detail.hidden = !detailSlot.querySelector('.call-card');
    section.classList.toggle('has-detail', !detail.hidden);
    const rowList = orderNeedsHandling(list.filter((e) => !e.inDetail && e.id !== ringId));
    rows.innerHTML = rowList.length
      ? `<div class="mtray-sec">Needs handling</div>` + rowList.map((e) => rowHtml(e, nowMs)).join('')
      : '';
    section.hidden = !list.length;
  }

  let queued = null;
  function changed(extra) {
    clearTimeout(queued);
    queued = setTimeout(() => { arrange(); if (typeof onChange === 'function') onChange(extra || {}); }, 30);
  }

  // A card closed (× / Close) or its details loaded (the name) → rows follow.
  const watch = new MutationObserver(() => changed());
  for (const el of [detailSlot, store]) watch.observe(el, { childList: true, subtree: true });
  section.addEventListener('cc:glance', () => changed());

  section.addEventListener('click', (ev) => {
    const row = ev.target.closest('[data-call-row]');
    const act = ev.target.closest('[data-call-act]');
    if (row || (act && act.dataset.callAct === 'answer')) {
      const id = row ? row.dataset.callRow : act.dataset.callId;
      const card = cards().find((c) => c.dataset.callId === id);
      if (card) openCard(card);
      return;
    }
    if (act && act.dataset.callAct === 'customer') {
      if (window.openCustomerById) window.openCustomerById(act.dataset.customerId);
      return;
    }
    if (act && act.dataset.callAct === 'back') {
      const cur = detailSlot.querySelector('.call-card');
      if (cur) store.appendChild(cur);
      arrange();
      if (typeof onChange === 'function') onChange({});
    }
  });

  setInterval(() => { if (cards().length) { arrange(); if (typeof onChange === 'function') onChange({}); } }, TICK_MS);
  arrange();

  return {
    // A new card from callerCard. Rings from its call's start (or now).
    add(card) {
      if (!card || !card.classList || !card.classList.contains('call-card')) return;
      if (!card.dataset.ringStart) card.dataset.ringStart = String(ringStartMs(card._call, Date.now()));
      store.appendChild(card);
      arrange();
      // `ringing`: the tray opens by itself only for a call ringing NOW — a backfilled
      // call from earlier today (e.g. after a reload) just joins the list quietly.
      if (typeof onChange === 'function') onChange({ added: true, ringing: isRinging(Number(card.dataset.ringStart), Date.now()) });
    },
    has: (id) => cards().some((c) => c.dataset.callId === String(id)),
    count: () => cards().length,
    // Count every call on this board; only a not-yet-opened one makes the badge pulse.
    strip: () => {
      const list = cards().map(entry);
      return { count: list.length, ringing: stripCalls(list.filter((e) => !e.answered)).ringing };
    },
    inDetail: () => !!detailSlot.querySelector('.call-card'),
  };
}
