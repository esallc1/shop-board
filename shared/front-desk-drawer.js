/* ============================================================
   front-desk-drawer.js — the ONE call a board makes to get the bottom drawer
   with its two tabs: "📝 Desk pad" (N, this computer only) and "📋 Whiteboard"
   (W, shared, read from the database).
   Wiring: docs/wiring/desk-pad.md §2 (the drawer) · docs/wiring/whiteboard.md.

   Today only advisor-board.html mounts it. Mounting it on another office board
   later = its three stylesheets + this call — no per-board copy of the code.
   `db` = that board's signed-in Supabase client (only the Whiteboard uses it).
   ============================================================ */
import { mountBottomDrawer } from './bottom-drawer.js';
import { createDeskPadPanel } from './desk-pad.js';
import { createWhiteboardPanel } from './whiteboard.js';

export function mountFrontDeskDrawer({ db } = {}) {
  return mountBottomDrawer({
    panels: [
      createDeskPadPanel,
      (ctx) => createWhiteboardPanel(ctx, { db }),
    ],
  });
}
