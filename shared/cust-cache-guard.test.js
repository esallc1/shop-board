/* ============================================================
   cust-cache-guard.test.js — the advisor board's customer-list cache must stay
   honest.

   The bug this locks: `custAllList` was fetched once per page load and cached
   behind `custAllLoaded`, invalidated ONLY by the error-retry button. A customer
   created or renamed in the same session was invisible to the Customers search
   until the page was closed and reopened — the search said "no matches" about
   somebody who exists, which is how duplicate customer files get made. Found on
   prod 2026-09-17.

   advisor-board.html is one inline-script page, so this is a STATIC guard (same
   approach as shared/pin-login.test.js's sweep): it reads the file and asserts
   the rule, which is what a future edit would break.

   THE RULE: every write to `customers` in that page invalidates the cache, and
   the page carries a realtime subscription + a focus backstop for the writes it
   cannot see (another tab, another person).
   Run: npm test   (node --test)
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'advisor-board.html'), 'utf8');
const LINES = SRC.split('\n');

// Write calls against `customers`: the .from('customers') line itself, or one of
// the next few lines, carrying insert/update/upsert/delete.
function customerWriteSites() {
  const sites = [];
  LINES.forEach((line, i) => {
    if (!/\.from\('customers'\)/.test(line)) return;
    const window_ = LINES.slice(i, i + 3).join(' ');
    if (/\.(insert|update|upsert|delete)\(/.test(window_)) sites.push(i + 1);   // 1-indexed
  });
  return sites;
}

test('the page still has customer write sites to check (guard is not vacuous)', () => {
  const sites = customerWriteSites();
  assert.ok(sites.length >= 4, 'expected at least 4 customer writes, found ' + sites.length + ' at ' + sites);
});

test('EVERY customer write invalidates the cached list', () => {
  const missing = [];
  for (const lineNo of customerWriteSites()) {
    // The invalidate call sits with the write's success path — look a little
    // ahead and a little behind so either ordering passes.
    const near = LINES.slice(Math.max(0, lineNo - 4), lineNo + 14).join('\n');
    if (!/cdInvalidateCustList/.test(near)) {
      missing.push(lineNo + ': ' + LINES[lineNo - 1].trim().slice(0, 90));
    }
  }
  assert.deepEqual(missing, [],
    'customer write(s) with no cache invalidation — a created/renamed customer ' +
    'will be unfindable in the search until a full page reload');
});

test('the invalidator MARKS STALE and never drops a list that loaded', () => {
  const fn = SRC.slice(SRC.indexOf('function invalidateCustAllList()'));
  const body = fn.slice(0, fn.indexOf('\n    }') + 6);
  assert.match(body, /custAllStale = true;/);
  // The only nulling allowed is the "we never had one" else-branch.
  assert.match(body, /\} else \{[\s\S]*custAllList = null;[\s\S]*custAllLoaded = false;[\s\S]*\}/);
  assert.match(SRC, /window\.cdInvalidateCustList = invalidateCustAllList;/);
});

test('a stale list keeps being served while a fresh one is fetched', () => {
  const fn = SRC.slice(SRC.indexOf('async function ensureCustAllList()'));
  const body = fn.slice(0, fn.indexOf('\n    }') + 6);
  // serve-then-revalidate, in that order
  assert.ok(body.indexOf('if (custAllStale) refreshCustAllList();') < body.indexOf('return custAllList;'));
  assert.match(SRC, /function refreshCustAllList\(\)/);
  assert.match(SRC, /if \(custRefreshInFlight\) return custRefreshInFlight;/);   // deduped
  assert.match(SRC, /if \(seq === custRenderSeq\) rerenderCustListIfOpen\(\);/); // no stale clobber
});

test('AN EMPTY CACHE IS NEVER RENDERED AS "no matches" (the b0ef5fc regression)', () => {
  const search = SRC.slice(SRC.indexOf('function renderCustSearch(q)'));
  const body = search.slice(0, search.indexOf('\n    }') + 6);
  // not-loaded → loading + fetch + bail, BEFORE any filtering
  assert.match(body, /if \(!custAllLoaded \|\| !custAllList\) \{/);
  assert.match(body, /Loading customers…/);
  assert.ok(body.indexOf('!custAllLoaded') < body.indexOf('list.filter('),
    'the not-loaded guard must come before the filter');
  const browse = SRC.slice(SRC.indexOf('function renderCustBrowse()'));
  const bbody = browse.slice(0, browse.indexOf('\n    }') + 6);
  assert.match(bbody, /!custAllLoaded[\s\S]*Loading customers…/);
  assert.match(bbody, /if \(!ferr && !custAllLoaded\) ensureCustAllList\(\)\.then\(rerenderCustListIfOpen\);/);
});

test('a realtime subscription on customers exists, in the board’s own idiom', () => {
  assert.match(SRC, /db\.channel\('advisor-board-customers-live'\)/);
  assert.match(SRC, /table: 'customers'/);
  // removeChannel guard, like every other channel on this board
  assert.match(SRC, /if \(custChannel\) db\.removeChannel\(custChannel\);/);
});

test('coming back to the tab marks the list stale (backstop for a dead socket)', () => {
  const vr = SRC.slice(SRC.indexOf('VIEW_REFRESH.customer = {'));
  const refetch = vr.slice(0, vr.indexOf('};'));
  assert.match(refetch, /invalidateCustAllList\(\)/);
});

test('the cache itself is NOT removed — a fresh cached list is served with no fetch', () => {
  const fn = SRC.slice(SRC.indexOf('async function ensureCustAllList()'));
  const body = fn.slice(0, fn.indexOf('\n    }') + 6);
  assert.match(body, /if \(custAllLoaded && custAllList\) \{/);
  assert.match(SRC, /const list = custAllList \|\| \[\];/);
  // The ONLY fetch trigger inside the render path is a STALE or MISSING list —
  // never an unconditional one (that would be a fetch per keystroke).
  const search = SRC.slice(SRC.indexOf('function renderCustSearch(q)'));
  const sbody = search.slice(0, search.indexOf('\n    }') + 6);
  const slines = sbody.split('\n');
  slines.forEach((line, i) => {
    if (!/refreshCustAllList\(\)|ensureCustAllList\(\)/.test(line)) return;
    // The trigger must be guarded — on the line itself or by the block it sits in.
    const scope = slines.slice(Math.max(0, i - 3), i + 1).join(' ');
    assert.match(scope, /custAllStale|custAllLoaded|custAllList/,
      'unguarded fetch in the render path: ' + line.trim());
  });
});

test('the error-retry path still resets the cache (unchanged behavior)', () => {
  assert.match(SRC, /custAllList = null; custAllLoaded = false; window\.cdCustFetchError = null;/);
});
