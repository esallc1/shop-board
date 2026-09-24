/* ============================================================
   front-desk-drawer.js — the ONE call a board makes to get the bottom drawer
   with its two tabs: "📝 Desk pad" (N, this computer only) and "📋 Whiteboard"
   (W, shared, read from the database).
   Wiring: docs/wiring/desk-pad.md §2 (the drawer) · docs/wiring/whiteboard.md.

   Today only advisor-board.html mounts it. Mounting it on another office board
   later = its three stylesheets + this call — no per-board copy of the code.
   `db` = that board's signed-in Supabase client (only the Whiteboard uses it).
   It also wires the Desk pad's 📌 to the Whiteboard's pin(text) — so the pad
   stays network-free and the Whiteboard owns the one write path.
   ============================================================ */
import { mountBottomDrawer } from './bottom-drawer.js';
import { createDeskPadPanel } from './desk-pad.js';
import { createWhiteboardPanel } from './whiteboard.js';

export function mountFrontDeskDrawer({ db } = {}) {
  // 📌 on a sticky → the Whiteboard's pin(text). The pad gets only this function
  // (it never touches the network); the Whiteboard panel does the post.
  let board = null;
  const pinToBoard = (text) => (board && typeof board.pin === 'function'
    ? board.pin(text)
    : Promise.resolve({ ok: false, error: "The whiteboard isn't ready yet — try again in a moment." }));
  return mountBottomDrawer({
    panels: [
      (ctx) => createDeskPadPanel(ctx, { pinToBoard }),
      (ctx) => (board = createWhiteboardPanel(ctx, { db })),
    ],
  });
}
