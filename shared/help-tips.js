/* ============================================================
   help-tips.js — reusable "?" help bubbles (drop-in, no deps).

   USAGE
     <script src="shared/help-tips.js"></script>
     <button type="button" class="help-tip" data-tip="Short text."></button>

   The script injects its own <style> (so it works even without
   board-shell.css), renders each marker as a small round "?" pill,
   and on tap opens ONE bubble anchored to it showing data-tip + an "×".
   Closes on ×, outside-tap, or Escape. Positions next to the "?" and
   flips to stay inside the viewport. Touch-first (click, no hover
   dependency). Idempotent — including it twice is harmless. Works with
   markers added after load (event delegation), so re-rendered boards
   (e.g. a picker in a tab) keep working.
   ============================================================ */
(function () {
  if (window.__helpTipsInit) return;     // idempotent — safe to include twice
  window.__helpTipsInit = true;

  var STYLE = [
    '.help-tip{',
    '  -webkit-appearance:none;appearance:none;box-sizing:border-box;',
    '  display:inline-flex;align-items:center;justify-content:center;',
    '  width:22px;height:22px;min-width:22px;padding:0;margin:0;',
    '  border-radius:50%;border:1px solid currentColor;background:transparent;',
    '  color:#9aa1b0;opacity:.72;cursor:pointer;vertical-align:middle;flex:0 0 auto;',
    '  font:700 12px/1 system-ui,-apple-system,Segoe UI,sans-serif;',
    '  -webkit-tap-highlight-color:transparent;transition:opacity .12s,color .12s;',
    '}',
    '.help-tip::before{content:"?";}',
    '.help-tip:hover{opacity:1;}',
    '.help-tip.help-tip-active{opacity:1;color:#5b5ef4;border-color:#5b5ef4;}',
    '.help-tip-bubble{',
    '  position:absolute;z-index:2147483000;max-width:250px;',
    '  background:#1a1f36;color:#fff;border-radius:10px;',
    '  padding:10px 32px 10px 13px;',
    '  font:500 12.5px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;',
    '  box-shadow:0 10px 28px rgba(20,30,60,.30);',
    '}',
    '.help-tip-bubble .help-tip-text{display:block;}',
    '.help-tip-bubble .help-tip-close{',
    '  position:absolute;top:4px;right:4px;width:22px;height:22px;padding:0;',
    '  border:none;background:transparent;color:#cfd3de;cursor:pointer;',
    '  border-radius:6px;font:400 17px/1 system-ui,sans-serif;',
    '  display:flex;align-items:center;justify-content:center;',
    '}',
    '.help-tip-bubble .help-tip-close:hover{background:rgba(255,255,255,.14);color:#fff;}'
  ].join('\n');

  function injectStyle() {
    if (document.getElementById('help-tips-style')) return;
    var s = document.createElement('style');
    s.id = 'help-tips-style';
    s.textContent = STYLE;
    (document.head || document.documentElement).appendChild(s);
  }

  var bubble = null;    // the single open bubble element
  var anchor = null;    // the .help-tip it's anchored to

  function close() {
    if (bubble && bubble.parentNode) bubble.parentNode.removeChild(bubble);
    if (anchor) anchor.classList.remove('help-tip-active');
    bubble = null;
    anchor = null;
  }

  function position() {
    if (!bubble || !anchor) return;
    var r = anchor.getBoundingClientRect();
    var bw = bubble.offsetWidth, bh = bubble.offsetHeight, gap = 8;
    // default: below the "?", left edges aligned
    var top = r.bottom + gap, left = r.left;
    // flip above if it would overflow the bottom and there's room up top
    if (top + bh > window.innerHeight - 4 && r.top - gap - bh > 4) top = r.top - gap - bh;
    // clamp horizontally into the viewport
    if (left + bw > window.innerWidth - 4) left = window.innerWidth - 4 - bw;
    if (left < 4) left = 4;
    // .help-tip-bubble is position:absolute → add scroll offset
    bubble.style.top = (top + window.pageYOffset) + 'px';
    bubble.style.left = (left + window.pageXOffset) + 'px';
  }

  function openFor(btn) {
    injectStyle();
    close();
    bubble = document.createElement('div');
    bubble.className = 'help-tip-bubble';
    var text = document.createElement('span');
    text.className = 'help-tip-text';
    text.textContent = btn.getAttribute('data-tip') || '';   // textContent = no HTML injection
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'help-tip-close';
    x.setAttribute('aria-label', 'Close');
    x.textContent = '×';   // ×
    bubble.appendChild(text);
    bubble.appendChild(x);
    document.body.appendChild(bubble);
    anchor = btn;
    btn.classList.add('help-tip-active');
    position();
  }

  // One delegated click handler covers current AND future markers.
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('.help-tip-close')) { e.preventDefault(); close(); return; }
    var tip = t.closest('.help-tip');
    if (tip) {
      e.preventDefault();
      e.stopPropagation();
      if (anchor === tip) close();     // tapping the same "?" toggles it shut
      else openFor(tip);
      return;
    }
    if (bubble && !bubble.contains(t)) close();   // outside tap
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' || e.key === 'Esc') close();
  });
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);   // capture — scroll doesn't bubble

  injectStyle();
})();
