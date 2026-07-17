// The docs-site "Ask AI" embed (Wave 5 item 20 — the Kapa motion), served verbatim at
// GET /answers.js. Distinct from widget.js (the support messenger): this one is a Q&A
// surface for documentation sites — a floating "Ask AI" pill (or an inline-mounted button)
// that opens a centered modal, answers from the published knowledge base via POST
// /public/ask (audience-scoped server-side), and cites its sources. No escalation lane,
// no conversation state — ask, read, ask another.
//
// Config via the script tag:
//   <script src="https://api.example.com/answers.js"
//           data-noola-key="wk_..."            (required — a widget key)
//           data-noola-api="https://api...."   (default: script origin)
//           data-noola-accent="#4f46e5"
//           data-noola-title="Ask AI"
//           data-noola-mount="#ask-ai-slot">   (optional — inline mount instead of the pill)
//
// Written with single-quoted strings + concatenation only (no backticks / ${…}) so it
// survives being embedded in this template literal.
export const ANSWERS_JS = String.raw`(function () {
  'use strict';
  var script = document.currentScript || document.querySelector('script[data-noola-key]');
  if (!script) return;
  var KEY = script.getAttribute('data-noola-key') || '';
  var API = (script.getAttribute('data-noola-api') || new URL(script.src).origin).replace(/\/+$/, '');
  var TITLE = script.getAttribute('data-noola-title') || 'Ask AI';
  var ACCENT = script.getAttribute('data-noola-accent') || '#4f46e5';
  var MOUNT = script.getAttribute('data-noola-mount') || '';
  if (!KEY) { console.warn('[noola answers] missing data-noola-key'); return; }

  var host = document.createElement('div');
  document.body.appendChild(host);
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  var css =
    ':host,*{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    '.pill{position:fixed;bottom:20px;right:20px;display:inline-flex;align-items:center;gap:8px;border:none;cursor:pointer;' +
      'background:' + ACCENT + ';color:#fff;border-radius:999px;padding:11px 18px;font-size:14px;font-weight:600;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.22);z-index:2147483000;transition:transform .15s ease-out}' +
    '.pill:active{transform:scale(.96)}' +
    '.pill svg{width:16px;height:16px}' +
    '.ov{position:fixed;inset:0;background:rgba(15,17,21,.45);display:none;z-index:2147483001;opacity:0;transition:opacity .18s ease-out}' +
    '.ov.on{display:block;opacity:1}' +
    '.dlg{position:fixed;top:14vh;left:50%;transform:translateX(-50%) translateY(6px) scale(.98);width:640px;max-width:calc(100vw - 32px);' +
      'max-height:70vh;background:#fff;color:#111827;border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.3);display:none;' +
      'flex-direction:column;overflow:hidden;z-index:2147483002;opacity:0;transition:opacity .18s ease-out,transform .18s ease-out}' +
    '.dlg.on{display:flex;opacity:1;transform:translateX(-50%)}' +
    '.in{display:flex;gap:8px;padding:14px;border-bottom:1px solid #e5e7eb}' +
    '.in input{flex:1;border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px;font:inherit;font-size:15px;outline:none}' +
    '.in input:focus{border-color:' + ACCENT + '}' +
    '.in button{border:none;background:' + ACCENT + ';color:#fff;border-radius:10px;padding:0 16px;font-weight:600;cursor:pointer;font-size:14px}' +
    '.in button:disabled{opacity:.5;cursor:default}' +
    '.out{flex:1;overflow-y:auto;padding:16px;font-size:14px;line-height:1.6}' +
    '.hint{color:#6b7280;font-size:13px}' +
    '.ans{white-space:pre-wrap;word-wrap:break-word}' +
    '.src{margin-top:14px;padding-top:10px;border-top:1px solid #f3f4f6;font-size:12px;color:#6b7280}' +
    '.src b{color:#374151}' +
    '.think span{display:inline-block;width:6px;height:6px;border-radius:50%;background:#9ca3af;margin:0 1px;animation:bd 1s infinite}' +
    '.think span:nth-child(2){animation-delay:.15s}.think span:nth-child(3){animation-delay:.3s}' +
    '@keyframes bd{0%,100%{opacity:.3}50%{opacity:1}}' +
    '.ft{padding:8px 14px;border-top:1px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#9ca3af}' +
    '.ft button{border:none;background:none;color:#6b7280;font-size:12px;cursor:pointer;text-decoration:underline;padding:0}' +
    '@media (prefers-reduced-motion:reduce){.pill,.ov,.dlg{transition:none}}';

  var style = document.createElement('style');
  style.textContent = css;
  root.appendChild(style);

  var sparkSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.7L19.6 10l-5.7 1.9L12 17.6l-1.9-5.7L4.4 10l5.7-1.3z"/></svg>';

  var wrap = document.createElement('div');
  wrap.innerHTML =
    '<div class="ov"></div>' +
    '<div class="dlg" role="dialog" aria-modal="true" aria-label="' + TITLE.replace(/"/g, '') + '">' +
      '<div class="in"><input id="baq" placeholder="Ask a question about the docs…" autocomplete="off"><button id="bago">Ask</button></div>' +
      '<div class="out" id="baout"><p class="hint">Answers come from the knowledge base and cite their sources.</p></div>' +
      '<div class="ft"><button id="baclr">Clear</button><span>AI answers can make mistakes</span></div>' +
    '</div>';
  root.appendChild(wrap);

  var ov = root.querySelector('.ov');
  var dlg = root.querySelector('.dlg');
  var input = root.querySelector('#baq');
  var goBtn = root.querySelector('#bago');
  var out = root.querySelector('#baout');
  var clr = root.querySelector('#baclr');
  var busy = false;

  // Trigger: an inline-mounted button when data-noola-mount matches, else the floating pill.
  var trigger = null;
  var slot = MOUNT ? document.querySelector(MOUNT) : null;
  if (slot) {
    trigger = document.createElement('button');
    trigger.textContent = TITLE;
    trigger.setAttribute('style', 'display:inline-flex;align-items:center;gap:6px;border:none;cursor:pointer;background:' + ACCENT + ';color:#fff;border-radius:8px;padding:8px 14px;font-size:14px;font-weight:600;font-family:inherit');
    slot.appendChild(trigger);
  } else {
    trigger = document.createElement('button');
    trigger.className = 'pill';
    trigger.innerHTML = sparkSvg + '<span>' + esc(TITLE) + '</span>';
    root.appendChild(trigger);
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function openDlg() {
    ov.classList.add('on'); dlg.classList.add('on');
    setTimeout(function () { input.focus(); }, 30);
    document.addEventListener('keydown', onKey);
  }
  function closeDlg() {
    ov.classList.remove('on'); dlg.classList.remove('on');
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') closeDlg(); }

  function ask() {
    var q = input.value.trim();
    if (!q || busy) return;
    busy = true; goBtn.disabled = true;
    out.innerHTML = '<div class="think"><span></span><span></span><span></span></div>';
    fetch(API + '/public/ask', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY, question: q })
    }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (s) {
      var html = '<div class="ans">' + esc(s.answer || 'No answer found.') + '</div>';
      if (s.citations && s.citations.length) {
        var names = [];
        for (var i = 0; i < s.citations.length && names.length < 4; i++) {
          if (names.indexOf(s.citations[i].title) < 0) names.push(s.citations[i].title);
        }
        html += '<div class="src"><b>Sources:</b> ' + names.map(esc).join(' · ') + '</div>';
      }
      out.innerHTML = html;
    }).catch(function () {
      out.innerHTML = '<p class="hint">Sorry — something went wrong. Please try again.</p>';
    }).finally(function () { busy = false; goBtn.disabled = false; input.focus(); });
  }

  trigger.addEventListener('click', openDlg);
  ov.addEventListener('click', closeDlg);
  goBtn.addEventListener('click', ask);
  clr.addEventListener('click', function () { input.value = ''; out.innerHTML = '<p class="hint">Answers come from the knowledge base and cite their sources.</p>'; input.focus(); });
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') ask(); });
})();`;
