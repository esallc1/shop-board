/* ============================================================
   pin-login.js — the tech PIN login for my-numbers.html.

   The PIN is checked INSIDE the database by the SECURITY DEFINER function
   `login_with_pin(p_phone, p_pin)` (migrations/20260917_pin_off_public_M1_*).
   The browser never reads a PIN or a hash: `employees.pin` is being dropped and
   the hashes live in `employee_secrets`, which no API role can read.

   The function returns ZERO rows for every failure — unknown phone, wrong PIN,
   inactive, ambiguous phone, and LOCKED (5 misses → 15 min) all look the same on
   purpose, so this module cannot and does not tell them apart.

   Returns the same shape findEmployee always did — { id, name, phone, role },
   where id is the PHONE (My Numbers' session id; docs/wiring/my-numbers.md §1) —
   or null.

   Usage:  const tech = await PinLogin.login(db, phone, pin);
   ============================================================ */
(function (global) {
  async function login(db, phone, pin) {
    if (!db) return null;
    try {
      const r = await db.rpc('login_with_pin', { p_phone: String(phone || ''), p_pin: String(pin || '') });
      if (r.error) { try { console.error('[Login] login_with_pin failed', r.error); } catch (e) {} return null; }
      const rows = Array.isArray(r.data) ? r.data : (r.data ? [r.data] : []);
      if (rows.length !== 1) return null;
      const d = rows[0];
      if (!d || !d.phone) return null;
      return { id: d.phone, name: d.name, phone: d.phone, role: d.role };
    } catch (e) {
      try { console.error('[Login] login_with_pin threw', e); } catch (e2) {}
      return null;
    }
  }

  global.PinLogin = { login: login };
})(typeof window !== 'undefined' ? window : globalThis);
