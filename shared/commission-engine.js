/* ============================================================
   commission-engine.js — the ONE advisor gross-profit + commission engine.

   Hours Engine Part 2. A per-ADVISOR weekly gross-profit rollup and the
   commission it drives, shared verbatim by the advisor board ("My Commission"),
   the owner board and the bookkeeping board ("Commission & Payout"). Both cards
   pull THIS module so the numbers can never diverge.

   Design mirrors ro-writer.js: pure functions, NO DOM and NO globals in the
   math core (so commission-engine.test.js can import it under `node --test`).
   The one impure helper, fetchInputs(db), is isolated at the bottom and does the
   resilient PostgREST reads; the browser build assigns window.CommissionEngine.

   ── GROSS PROFIT (the pay basis), locked with the owner 2026-08-08 ──
     advisor GP per RO = Σ labor-line revenue           (labor ≈ pure margin)
                       + Σ parts-line markup            (unit_price − unit_cost)
                       + Σ package-line margin          (unit_price − unit_cost)
     Shop Supply / Hazmat / Fee lines are EXCLUDED.
     Parts cost is ro_line_items.unit_cost; package cost is per-UNIT on
     package_units.unit_cost. When a parts/package line has NO real cost yet, GP
     falls back to price × the shop-wide assumed-margin fraction (parts_margin_pct
     / package_margin_pct); a real cost on the line always overrides.

   ── PAYOUT (locked) ──
     base $1,000 per full 40-hr week + 2.5% of THAT week's GP, WEEKLY-FINAL — no
     monthly true-up, no clawbacks. Base + % are per-advisor (employees.
     commission_base_weekly / commission_gp_pct); null → the code defaults below.
     The month figure is the SUM of the weeks' commission — informational only.

   Attribution: an RO's advisor is repair_orders.service_writer_id → employees.name
   (the printed "Service Advisor"). An RO with no writer is credited to NO ONE
   (never paid), same rule as Part 1's no-tech ROs. Weeks are Sunday–Saturday,
   America/New_York, bucketed by the STABLE set-once repair_orders.closed_at
   (fallback updated_at) — the SAME convention as the Part 1 Billed-Hrs rollup.
   ============================================================ */

// Code defaults — used when a per-advisor / shop value is null (pre-migration or
// simply unset). "Manny's plan" is exactly these defaults; nothing is hardcoded
// to one person.
export const DEFAULT_BASE_WEEKLY   = 1000;   // $ per full week
export const DEFAULT_GP_PCT        = 2.5;    // % of that week's GP
export const DEFAULT_PARTS_MARGIN  = 0.40;   // assumed GP fraction on parts w/o cost
export const DEFAULT_PACKAGE_MARGIN = 0.55;  // assumed GP fraction on packages w/o cost

const BILLED_STATUSES = ['invoice', 'closed'];   // "billed or closed", same as Part 1

// ── Date helpers (America/New_York, Sunday–Saturday) — identical convention to
// gm-board's Part 1 rollup. nowIso is injectable so tests are deterministic. ──
export function nyDateOf(ts) {
  if (!ts) return null;
  try { return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); } // YYYY-MM-DD in NY
  catch (e) { return null; }
}
function ymdToUtc(ymd) { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function utcToYmd(dt) { return dt.toISOString().slice(0, 10); }

export function weekWindow(nowIso) {
  const todayNy = nyDateOf(nowIso || new Date().toISOString());
  const base = ymdToUtc(todayNy);
  const start = new Date(base); start.setUTCDate(base.getUTCDate() - base.getUTCDay());   // Sunday
  const end = new Date(start); end.setUTCDate(start.getUTCDate() + 6);                     // Saturday
  return { startYmd: utcToYmd(start), endYmd: utcToYmd(end) };
}

// Month-to-date window [1st .. today] and the previous full calendar month.
export function monthWindows(nowIso) {
  const todayNy = nyDateOf(nowIso || new Date().toISOString());
  const [y, m] = todayNy.split('-').map(Number);
  const firstThis = `${y}-${String(m).padStart(2, '0')}-01`;
  const prevY = m === 1 ? y - 1 : y, prevM = m === 1 ? 12 : m - 1;
  const firstPrev = `${prevY}-${String(prevM).padStart(2, '0')}-01`;
  const lastPrev = utcToYmd(new Date(Date.UTC(y, m - 1, 0)));   // day 0 of this month = last day of prev
  return {
    monthKey: `${y}-${String(m).padStart(2, '0')}`,
    thisMonth: { startYmd: firstThis, endYmd: todayNy },
    lastMonth: { startYmd: firstPrev, endYmd: lastPrev },
  };
}

// How many Sun–Sat weeks the month-to-date spans (base accrues per week). Counts
// every week whose window overlaps [1st .. today] — so the in-progress week and
// a week straddling the month start each count once. Always ≥ 1.
export function weeksInMonthToDate(nowIso) {
  const { thisMonth } = monthWindows(nowIso);
  const firstSunday = ymdToUtc(weekWindow(thisMonth.startYmd + 'T12:00:00Z').startYmd);
  const todayUtc = ymdToUtc(thisMonth.endYmd);
  let n = 0;
  for (let s = new Date(firstSunday); utcToYmd(s) <= thisMonth.endYmd; s.setUTCDate(s.getUTCDate() + 7)) {
    n++;
    if (utcToYmd(s) > utcToYmd(todayUtc)) break;   // safety
  }
  return Math.max(1, n);
}

const inWindow = (ymd, w) => !!ymd && ymd >= w.startYmd && ymd <= w.endYmd;

// ── Gross profit ─────────────────────────────────────────────────────────────
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// GP for ONE line. opts: { partsMarginPct, packageMarginPct, packageCostById }.
export function lineGrossProfit(line, opts) {
  const o = opts || {};
  const qty = num(line.quantity);
  const price = num(line.unit_price);
  const rev = qty * price;
  switch (line.line_type) {
    case 'labor':
      return rev;                                   // labor ≈ pure margin
    case 'parts': {
      if (line.unit_cost != null) return rev - qty * num(line.unit_cost);
      const pm = o.partsMarginPct != null ? o.partsMarginPct : DEFAULT_PARTS_MARGIN;
      return rev * pm;                              // no real cost → assumed margin
    }
    case 'package': {
      const cost = o.packageCostById ? o.packageCostById[line.package_unit_id] : undefined;
      if (cost != null) return rev - qty * num(cost);   // qty is 1 for packages
      const gm = o.packageMarginPct != null ? o.packageMarginPct : DEFAULT_PACKAGE_MARGIN;
      return rev * gm;                              // no real cost → assumed margin
    }
    default:
      return 0;                                     // fee / shop_supply / hazmat — excluded
  }
}

export function roGrossProfit(lines, opts) {
  return (lines || []).reduce((s, l) => s + lineGrossProfit(l, opts), 0);
}

// Per-advisor pay plan from an employees row, applying code defaults for nulls.
export function advisorPlan(emp) {
  const b = emp && emp.commission_base_weekly;
  const p = emp && emp.commission_gp_pct;
  return {
    baseWeekly: (b != null && Number.isFinite(Number(b))) ? Number(b) : DEFAULT_BASE_WEEKLY,
    gpPct: (p != null && Number.isFinite(Number(p))) ? Number(p) : DEFAULT_GP_PCT,
  };
}

// Commission for a GP figure under a plan. Weekly-final: base is the flat weekly
// base (full-week assumption); commission = gpPct% of the period's GP.
export function commissionOf(gp, plan) {
  const g = num(gp);
  const pct = plan && plan.gpPct != null ? plan.gpPct : DEFAULT_GP_PCT;
  return Math.round(g * (pct / 100) * 100) / 100;
}

// ── The rollup both cards read ───────────────────────────────────────────────
// Pure. Inputs are already-fetched arrays (see fetchInputs). Returns per-advisor
// week / month / lastMonth figures + cross-advisor totals for the owner card.
export function compute(input) {
  const {
    ros = [], lines = [], employees = [], packageUnits = [],
    settings = {}, nowIso = null,
  } = input || {};

  const week = weekWindow(nowIso);
  const mw = monthWindows(nowIso);
  const weeksMTD = weeksInMonthToDate(nowIso);

  const opts = {
    partsMarginPct: settings.parts_margin_pct != null ? Number(settings.parts_margin_pct) : DEFAULT_PARTS_MARGIN,
    packageMarginPct: settings.package_margin_pct != null ? Number(settings.package_margin_pct) : DEFAULT_PACKAGE_MARGIN,
    packageCostById: {},
  };
  (packageUnits || []).forEach(u => { if (u && u.unit_cost != null) opts.packageCostById[u.id] = Number(u.unit_cost); });

  const empById = {}; const planByName = {}; const idByName = {};
  (employees || []).forEach(e => {
    empById[e.id] = e;
    if (e.name) { planByName[e.name] = advisorPlan(e); idByName[e.name] = e.id; }
  });

  const linesByRo = {};
  (lines || []).forEach(l => { (linesByRo[l.repair_order_id] = linesByRo[l.repair_order_id] || []).push(l); });

  // Per-advisor accumulators for the three windows.
  const blank = () => ({ gp: 0, roCount: 0 });
  const acc = {};                      // name → { week, month, lastMonth }
  const ensure = (name) => (acc[name] = acc[name] || { week: blank(), month: blank(), lastMonth: blank() });
  const unassigned = { week: blank(), month: blank(), lastMonth: blank() };   // no-writer GP, never paid

  (ros || []).forEach(ro => {
    if (!BILLED_STATUSES.includes(ro.status)) return;
    const stampYmd = nyDateOf(ro.closed_at || ro.updated_at);
    if (!stampYmd) return;
    const inWk = inWindow(stampYmd, week);
    const inTM = inWindow(stampYmd, mw.thisMonth);
    const inLM = inWindow(stampYmd, mw.lastMonth);
    if (!inWk && !inTM && !inLM) return;

    const gp = roGrossProfit(linesByRo[ro.id] || [], opts);
    const emp = ro.service_writer_id ? empById[ro.service_writer_id] : null;
    // Only ADVISORS are on the commission plan. GP written by a manager/owner
    // (also eligible RO writers) or by no one is tracked as unassigned — never paid.
    const bucket = emp && emp.name && emp.role === 'advisor' ? ensure(emp.name) : unassigned;
    if (inWk) { bucket.week.gp += gp; bucket.week.roCount += 1; }
    if (inTM) { bucket.month.gp += gp; bucket.month.roCount += 1; }
    if (inLM) { bucket.lastMonth.gp += gp; bucket.lastMonth.roCount += 1; }
  });

  const round2 = (v) => Math.round(v * 100) / 100;
  const advisors = {};
  Object.keys(acc).forEach(name => {
    const a = acc[name];
    const plan = planByName[name] || { baseWeekly: DEFAULT_BASE_WEEKLY, gpPct: DEFAULT_GP_PCT };
    const weekCommission = commissionOf(a.week.gp, plan);
    const monthCommission = commissionOf(a.month.gp, plan);       // = Σ weekly (linear)
    const lastMonthCommission = commissionOf(a.lastMonth.gp, plan);
    advisors[name] = {
      employeeId: idByName[name] || null,
      plan,
      week: {
        gp: round2(a.week.gp), roCount: a.week.roCount,
        base: plan.baseWeekly, commission: weekCommission,
        pay: round2(plan.baseWeekly + weekCommission),           // the check for THIS week
      },
      month: {
        gp: round2(a.month.gp), roCount: a.month.roCount,
        commission: monthCommission,
        baseAccrued: round2(plan.baseWeekly * weeksMTD),
        total: round2(plan.baseWeekly * weeksMTD + monthCommission),
      },
      lastMonth: { gp: round2(a.lastMonth.gp), commission: lastMonthCommission },
    };
  });

  // Cross-advisor totals for the owner/bookkeeping "Pay this week" line.
  const totals = { week: { gp: 0, roCount: 0, base: 0, commission: 0, pay: 0 }, month: { gp: 0, roCount: 0, commission: 0 } };
  Object.values(advisors).forEach(a => {
    totals.week.gp += a.week.gp; totals.week.roCount += a.week.roCount;
    totals.week.base += a.week.base; totals.week.commission += a.week.commission; totals.week.pay += a.week.pay;
    totals.month.gp += a.month.gp; totals.month.roCount += a.month.roCount; totals.month.commission += a.month.commission;
  });
  ['gp', 'base', 'commission', 'pay'].forEach(k => { totals.week[k] = round2(totals.week[k]); });
  ['gp', 'commission'].forEach(k => { totals.month[k] = round2(totals.month[k]); });

  return {
    week, month: mw.thisMonth, lastMonth: mw.lastMonth, monthKey: mw.monthKey, weeksInMonthToDate: weeksMTD,
    advisors, unassigned: {
      week: { gp: round2(unassigned.week.gp), roCount: unassigned.week.roCount },
      month: { gp: round2(unassigned.month.gp), roCount: unassigned.month.roCount },
    },
    totals,
  };
}

// ── Impure: resilient PostgREST reads (browser only) ─────────────────────────
// Selects the columns compute() needs and re-queries WITHOUT any not-yet-migrated
// optional column (probe cached across calls), so a board on the un-migrated
// schema still renders using defaults/fallbacks. Returns the four arrays compute
// expects. Never throws — returns empty arrays on hard failure.
const _colAvail = { closed_at: true, unit_cost: true, package_unit_id: true, commission: true, pkgCost: true };

export async function fetchInputs(db) {
  const out = { ros: [], lines: [], employees: [], packageUnits: [], _colAvail };
  // ROs (invoice/closed)
  try {
    let cols = _colAvail.closed_at ? 'id, service_writer_id, status, closed_at, updated_at' : 'id, service_writer_id, status, updated_at';
    let r = await db.from('repair_orders').select(cols).in('status', BILLED_STATUSES);
    if (r.error && _colAvail.closed_at && /closed_at/i.test(r.error.message || '')) {
      _colAvail.closed_at = false;
      r = await db.from('repair_orders').select('id, service_writer_id, status, updated_at').in('status', BILLED_STATUSES);
    }
    if (r.error) throw r.error;
    out.ros = r.data || [];
  } catch (e) { console.warn('[Commission] RO load failed', e); return out; }
  const ids = out.ros.map(r => r.id);
  if (!ids.length) { await _loadEmployees(db, out); return out; }
  // Line items
  try {
    const extra = [_colAvail.unit_cost ? 'unit_cost' : null, _colAvail.package_unit_id ? 'package_unit_id' : null].filter(Boolean).join(', ');
    let cols = 'repair_order_id, line_type, quantity, unit_price' + (extra ? ', ' + extra : '');
    let r = await db.from('ro_line_items').select(cols).in('repair_order_id', ids);
    if (r.error && _colAvail.unit_cost && /unit_cost/i.test(r.error.message || '')) { _colAvail.unit_cost = false; return fetchInputs(db); }
    if (r.error && _colAvail.package_unit_id && /package_unit_id/i.test(r.error.message || '')) { _colAvail.package_unit_id = false; return fetchInputs(db); }
    if (r.error) throw r.error;
    out.lines = r.data || [];
  } catch (e) { console.warn('[Commission] line load failed', e); }
  // package unit costs
  try {
    if (_colAvail.pkgCost) {
      let r = await db.from('package_units').select('id, unit_cost');
      if (r.error && /unit_cost/i.test(r.error.message || '')) { _colAvail.pkgCost = false; }
      else if (r.error) throw r.error;
      else out.packageUnits = r.data || [];
    }
  } catch (e) { /* non-fatal — packages fall back to assumed margin */ }
  await _loadEmployees(db, out);
  return out;
}

async function _loadEmployees(db, out) {
  try {
    let cols = _colAvail.commission ? 'id, name, role, active, commission_base_weekly, commission_gp_pct' : 'id, name, role, active';
    let r = await db.from('employees').select(cols);
    if (r.error && _colAvail.commission && /commission_(base_weekly|gp_pct)/i.test(r.error.message || '')) {
      _colAvail.commission = false;
      r = await db.from('employees').select('id, name, role, active');
    }
    if (r.error) throw r.error;
    out.employees = r.data || [];
  } catch (e) { console.warn('[Commission] employee load failed', e); }
}
