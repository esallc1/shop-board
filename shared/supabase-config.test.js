/* Tests for the hostname → Supabase creds selector. The paramount rule: every
   real PRODUCTION hostname resolves to PROD; only test.* / previews / localhost
   resolve to STAGING. A regression here could point prod at the staging DB (or a
   staging surface at prod), so these are exhaustive on the known hostnames.

   supabase-config.js ships as a CLASSIC browser <script> (this repo is ESM, so the
   file can't use import/export). We load the real file text into a vm sandbox with
   a fake `window` and drive the exposed pure selector. */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, 'supabase-config.js'), 'utf8');
const sandbox = { window: { location: { hostname: 'localhost' } } };
vm.createContext(sandbox);
new vm.Script(code).runInContext(sandbox);
const pick = sandbox.window.cdPickSupabaseCreds;

const PROD_HOSTS = [
  'leetransmissionshop.com',
  'www.leetransmissionshop.com',
  'board.leetransmissionshop.com',
  'BOARD.LeeTransmissionShop.com',              // case-insensitive
  'shop-board-ten.vercel.app',
  'shop-board-leetransmission-kiki.vercel.app',
  'anything-new.leetransmissionshop.com',       // a future prod subdomain is prod by default
];

const STAGING_HOSTS = [
  'test.leetransmissionshop.com',               // the one carve-out
  'TEST.leetransmissionshop.com',
  'shop-board-git-staging-leetransmission-kiki.vercel.app',
  'shop-board-git-feat-x-leetransmission-kiki.vercel.app',
  'localhost',
  '127.0.0.1',
  '',
  undefined,
];

test('the file exposes the pure selector on window', () => {
  assert.strictEqual(typeof pick, 'function');
});

test('every production hostname resolves to PROD', () => {
  for (const h of PROD_HOSTS) {
    assert.strictEqual(pick(h).env, 'production', `expected PROD for ${h}`);
  }
});

test('test.* / previews / localhost resolve to STAGING', () => {
  for (const h of STAGING_HOSTS) {
    assert.strictEqual(pick(h).env, 'staging', `expected STAGING for ${h}`);
  }
});

test('CD_SUPABASE snapshot resolves for the current origin', () => {
  assert.ok(sandbox.window.CD_SUPABASE);
  assert.strictEqual(sandbox.window.CD_SUPABASE.env, 'staging'); // localhost → staging
});
