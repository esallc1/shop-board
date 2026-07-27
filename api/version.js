/* ============================================================
   api/version.js — returns the deployed build's git commit SHA so a running
   (installed) PWA can detect a new deploy and PROMPT to refresh.

   Why a SHA and not the HTML ETag: a module-only deploy (the normal pattern
   here — e.g. shipping shared/roadmap.js alone) leaves the board HTML byte-
   identical, so its ETag doesn't move and an HTML-ETag check would miss it.
   VERCEL_GIT_COMMIT_SHA changes on EVERY deploy regardless of which files
   moved. (A deployment-id / VERCEL_URL would also move on a same-commit
   redeploy of identical code, which would false-prompt — the SHA does not.)

   VERCEL_GIT_COMMIT_SHA is a Vercel system env var, auto-populated per deploy
   for Git-connected projects — no build step, no manual env setup. If it's
   ever missing we return null, and shared/version-check.js stays silent.
   ============================================================ */
export default async function handler(req, res) {
  const version = process.env.VERCEL_GIT_COMMIT_SHA || null;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({ version });
}
