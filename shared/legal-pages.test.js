/* ============================================================
   legal-pages.test.js — the three public Meta App Review pages.
   Run: npm test   (node --test)

   Locks: privacy.html, terms.html and data-deletion.html exist at the repo
   root, name the business, and carry NO <script> — they must stay static and
   public forever (Meta's reviewers and crawler fetch them with no login).
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['privacy.html', 'terms.html', 'data-deletion.html'];

for (const page of PAGES) {
  test(`${page} exists, names the business, has no script`, () => {
    const file = join(ROOT, page);
    assert.ok(existsSync(file), `${page} missing`);
    const html = readFileSync(file, 'utf8');
    assert.ok(html.includes('EL SHADDAI AUTO LLC'), 'legal name missing');
    assert.ok(html.includes('Lee Transmission'), 'business name missing');
    assert.ok(!/<script/i.test(html), 'must not contain <script');
  });
}
