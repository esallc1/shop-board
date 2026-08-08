/* ============================================================
   commission-cards.js — the shared Advisor Commission widgets.

   Hours Engine Part 2. Two cards, one engine (commission-engine.js via
   window.CommissionEngine):
     • renderMine(el, {db, viewerName})  → the advisor's motivating "My
       Commission" card (leads with commission earned this month). The advisor
       sees ONLY themselves.
     • renderPayout(el, {db})            → the owner / bookkeeping "Commission &
       Payout" card (leads with the green "Pay this week" = base + this week's
       commission — the number the bookkeeper cuts the check for).

   Regular (non-module) script: self-injects its CSS and assigns
   window.CommissionCards, so any board includes it with one <script> tag. It
   reads window.CommissionEngine at call time (never at load), so load order vs
   the engine module is safe. Every figure comes from CommissionEngine.compute —
   the two cards can never disagree. Gating (feature switch) is the board's job;
   these just paint whatever compute returns.
   ============================================================ */
(function () {
  'use strict';

  const CSS = `
  .cmc-card{border:1px solid var(--cmc-line,#e6e7ec);border-radius:16px;overflow:hidden;
    background:var(--cmc-card,#fff);box-shadow:0 4px 16px rgba(20,20,50,.05);font-family:inherit}
  .cmc-head{padding:16px 20px;display:flex;justify-content:space-between;align-items:center;gap:12px;color:#fff}
  .cmc-head.mine{background:linear-gradient(135deg,#5b57e8,#8a86f2)}
  .cmc-head.payout{background:linear-gradient(135deg,#0f9d58,#15803d)}
  .cmc-tag{font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;opacity:.85;margin-bottom:4px}
  .cmc-title{font-size:17px;font-weight:800;margin:0;letter-spacing:-.01em}
  .cmc-big{font-size:31px;font-weight:800;letter-spacing:-.02em;white-space:nowrap}
  .cmc-body{padding:18px 20px}
  .cmc-chips{display:flex;gap:10px;flex-wrap:wrap}
  .cmc-chip{flex:1;min-width:104px;border:1px solid var(--cmc-line,#e6e7ec);border-radius:11px;padding:11px 13px;text-align:center;background:var(--cmc-chipbg,#fbfbfd)}
  .cmc-chip .v{font-size:19px;font-weight:800;letter-spacing:-.01em}
  .cmc-chip .k{font-size:11px;color:var(--cmc-muted,#5b6473);margin-top:3px}
  .cmc-note{font-size:13.5px;font-weight:600;color:var(--cmc-ink,#14213a);background:var(--cmc-note,#e7f7ee);
    border-radius:11px;padding:12px 14px;margin-top:14px;display:flex;align-items:center;gap:8px}
  .cmc-note.amber{background:#fef3e2;color:#b45309}
  .cmc-sub{font-size:12.5px;color:var(--cmc-muted,#5b6473);margin-top:12px}
  .cmc-sub b{color:var(--cmc-ink,#14213a)}
  .cmc-tbl{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:4px}
  .cmc-tbl th{text-align:left;font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:var(--cmc-muted,#5b6473);font-weight:700;padding:4px 6px}
  .cmc-tbl td{padding:9px 6px;border-top:1px solid var(--cmc-line,#e6e7ec);font-variant-numeric:tabular-nums}
  .cmc-tbl td.r{text-align:right;font-weight:700}
  .cmc-tbl tr.tot td{border-top:2px solid var(--cmc-ink,#14213a);font-weight:800;font-size:15px}
  .cmc-empty{padding:20px;color:var(--cmc-muted,#5b6473);text-align:center;font-size:13.5px}
  @media (prefers-color-scheme: dark){
    .cmc-card{--cmc-card:#1c2230;--cmc-line:#2c3444;--cmc-chipbg:#232a38;--cmc-ink:#e8ecf4;--cmc-muted:#9aa6b8;--cmc-note:#12351f}
  }`;

  function injectCss() {
    if (document.getElementById('cmc-css')) return;
    const st = document.createElement('style'); st.id = 'cmc-css'; st.textContent = CSS;
    document.head.appendChild(st);
  }

  const m0 = (v) => '$' + Math.round(Number(v) || 0).toLocaleString('en-US');
  const m2 = (v) => '$' + (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const monthName = (key) => {
    const [y, m] = (key || '').split('-').map(Number);
    if (!y || !m) return '';
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  };
  const esc = (s) => (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  async function load(db) {
    const E = window.CommissionEngine;
    if (!E || !db) return null;
    const input = await E.fetchInputs(db);
    return E.compute({ ...input, nowIso: new Date().toISOString() });
  }

  // ── Advisor's own card ───────────────────────────────────────
  async function renderMine(el, opts) {
    if (!el) return;
    injectCss();
    const db = opts && opts.db;
    const viewerName = opts && opts.viewerName;
    el.innerHTML = '<div class="cmc-card"><div class="cmc-empty">Loading your commission…</div></div>';
    let r; try { r = await load(db); } catch (e) { r = null; }
    if (!r) { el.innerHTML = '<div class="cmc-card"><div class="cmc-empty">Commission is unavailable right now.</div></div>'; return; }
    const a = viewerName ? r.advisors[viewerName] : null;
    if (!a) {
      el.innerHTML = `<div class="cmc-card"><div class="cmc-head mine"><div><div class="cmc-tag">Your commission · ${esc(monthName(r.monthKey))}</div><h2 class="cmc-title">Commission this month</h2></div><div class="cmc-big">$0</div></div>` +
        `<div class="cmc-body"><div class="cmc-note">💪 No closed ROs credited to you yet this month — every job you write and close builds your check.</div></div></div>`;
      return;
    }
    // pace vs last month (commission-to-date vs last month's full commission)
    const dLast = a.month.commission - a.lastMonth.commission;
    let pace;
    if (a.lastMonth.commission <= 0) pace = `First tracked month — you're at <b>${m2(a.month.commission)}</b> so far.`;
    else if (dLast >= 0) pace = `🔥 Already <b>${m2(dLast)}</b> ahead of all of last month (${m2(a.lastMonth.commission)}).`;
    else pace = `<b>${m2(-dLast)}</b> to go to match last month (${m2(a.lastMonth.commission)}). Keep selling.`;

    el.innerHTML = `
      <div class="cmc-card">
        <div class="cmc-head mine">
          <div>
            <div class="cmc-tag">Your commission · ${esc(monthName(r.monthKey))}</div>
            <h2 class="cmc-title">Commission this month</h2>
          </div>
          <div class="cmc-big">${m2(a.month.commission)}</div>
        </div>
        <div class="cmc-body">
          <div class="cmc-chips">
            <div class="cmc-chip"><div class="v">${m0(a.month.gp)}</div><div class="k">GP written</div></div>
            <div class="cmc-chip"><div class="v">${a.month.roCount}</div><div class="k">ROs closed</div></div>
            <div class="cmc-chip"><div class="v">${m0(a.month.baseAccrued)}</div><div class="k">Base accrued</div></div>
            <div class="cmc-chip"><div class="v">${m0(a.month.total)}</div><div class="k">Total this month</div></div>
          </div>
          <div class="cmc-note">${pace}</div>
          <div class="cmc-sub">This week so far (${esc(r.week.startYmd)} – ${esc(r.week.endYmd)}): <b>${m2(a.week.pay)}</b> — base ${m0(a.week.base)} + commission <b>${m2(a.week.commission)}</b> · GP ${m0(a.week.gp)} · ${a.week.roCount} RO${a.week.roCount === 1 ? '' : 's'}. Paid weekly-final.</div>
        </div>
      </div>`;
  }

  // ── Owner / bookkeeping payout card ──────────────────────────
  async function renderPayout(el, opts) {
    if (!el) return;
    injectCss();
    const db = opts && opts.db;
    el.innerHTML = '<div class="cmc-card"><div class="cmc-empty">Loading commission & payout…</div></div>';
    let r; try { r = await load(db); } catch (e) { r = null; }
    if (!r) { el.innerHTML = '<div class="cmc-card"><div class="cmc-empty">Commission is unavailable right now.</div></div>'; return; }
    const names = Object.keys(r.advisors).sort();
    const rowsHtml = names.length
      ? names.map(n => {
          const a = r.advisors[n];
          return `<tr><td>${esc(n)}</td><td class="r">${m0(a.week.base)}</td><td class="r">${m2(a.week.commission)}</td><td class="r">${m2(a.week.pay)}</td></tr>`;
        }).join('')
      : '';
    const totalPay = r.totals.week.pay;

    el.innerHTML = `
      <div class="cmc-card">
        <div class="cmc-head payout">
          <div>
            <div class="cmc-tag">Pay this week · ${esc(r.week.startYmd)} – ${esc(r.week.endYmd)}</div>
            <h2 class="cmc-title">Commission &amp; Payout</h2>
          </div>
          <div class="cmc-big">${m2(totalPay)}</div>
        </div>
        <div class="cmc-body">
          ${names.length ? `
          <table class="cmc-tbl">
            <thead><tr><th>Advisor</th><th style="text-align:right">Base</th><th style="text-align:right">+ Commission</th><th style="text-align:right">= Pay this week</th></tr></thead>
            <tbody>${rowsHtml}${names.length > 1 ? `<tr class="tot"><td>Total</td><td class="r">${m0(r.totals.week.base)}</td><td class="r">${m2(r.totals.week.commission)}</td><td class="r">${m2(totalPay)}</td></tr>` : ''}</tbody>
          </table>
          <div class="cmc-sub">This week: <b>${m0(r.totals.week.gp)}</b> gross profit across <b>${r.totals.week.roCount}</b> closed RO${r.totals.week.roCount === 1 ? '' : 's'}. Running month commission (info): <b>${m2(r.totals.month.commission)}</b>.</div>
          <div class="cmc-note">✅ Pay = base + this week's commission (a % of the week's gross profit), already summed. Weekly-final — no monthly true-up.</div>
          ${r.unassigned.week.gp > 0 ? `<div class="cmc-sub">Note: ${m0(r.unassigned.week.gp)} of GP this week was on ROs with no advisor assigned — not paid to anyone.</div>` : ''}
          ` : `<div class="cmc-empty">No advisor-written ROs closed this week yet.</div>`}
        </div>
      </div>`;
  }

  window.CommissionCards = { renderMine, renderPayout };
})();
