// The embeddable messenger widget, served verbatim at GET /widget.js. It is a self-contained
// IIFE (shadow-DOM launcher + a multi-view panel: Home / Messages / Help) plus the Noola(...)
// JS SDK (identify visitors, track activity, visibility controls) — Intercom-style. It reads its
// config from its own <script data-noola-*> tag AND from GET /public/config (the admin's
// Settings → Messenger personalization), and talks to the public lanes:
//   GET  /public/config       — per-key personalization (accent / greeting / position / tabs)
//   POST /public/ask          — AI answer (+ escalate:true to hand off to a human)
//   POST /public/conversation — poll agent replies once escalated (two-way live chat)
//   GET  /public/kb[/search]  — help center articles + search
//   GET  /public/kb/:slug     — a single article
//   POST /public/identify     — Noola('boot'|'update') → upsert the contact + last-seen
//   POST /public/track        — Noola('track', name, meta) → a custom activity event
// The SDK command queue is global as window.Noola(...). The plain <script data-noola-key> embed
// (no boot call) still works exactly as before — an anonymous visitor.
//
// Written with single-quoted strings + concatenation only (no backticks / ${…}) so it survives
// being embedded in this template literal.
export const WIDGET_JS = String.raw`(function () {
  'use strict';

  // ---- config from the embedding <script> tag (fallback until /public/config resolves) ----
  var script = document.currentScript || document.querySelector('script[data-noola-key]');
  var scriptSrc = (script && script.src) || '';
  var dataKey = script ? (script.getAttribute('data-noola-key') || '') : '';
  var API = (script && (script.getAttribute('data-noola-api') || (scriptSrc ? new URL(scriptSrc).origin : ''))) || '';
  API = API.replace(/\/+$/, '');
  // Optional real-time lane: the Phoenix edge base URL (e.g. wss://edge.example.app). When set,
  // agent replies stream in live over a WebSocket; polling stays on as a fallback.
  var EDGE = ((script && script.getAttribute('data-noola-edge')) || '').replace(/\/+$/, '');

  var CFG = {
    accent: (script && script.getAttribute('data-noola-accent')) || '#4f46e5',
    title: (script && script.getAttribute('data-noola-title')) || 'Ask us anything',
    greeting: 'Hi there \u{1F44B}  Ask a question for an instant answer, or browse our help center.',
    position: 'right',
    tabs: { home: true, messages: true, help: true }
  };

  var KEY = dataKey;              // resolved widget key (data attr OR Noola('boot',{key}))
  var mounted = false;
  var launcherHidden = false;
  var panelOpen = false;
  var configLoaded = false;

  // ---- identity + conversations (persisted per key) ----
  var identity = { email: null, name: null, user_id: null, company: null, attributes: {} };
  var convs = [];                 // [{ id, escalated, updatedAt, unread, msgs:[{role,body,id,at}] }]
  var view = 'home';              // home | messages | help | thread | article
  var threadId = null;            // conversation id when view === 'thread'
  var articleSlug = null;
  var busy = false;

  // live lanes (scoped to the active escalated conversation)
  var activeConvId = null;
  var pollTimer = null;
  var ws = null, wsHb = null, wsRef = 0;
  // While an AI answer streams token-by-token (SSE), the poll/WS/hydrate reconcilers must NOT
  // rebuild #log from the server — the answer isn't persisted until the stream's 'done', so a
  // mid-stream hydrate would wipe the live bubble. Set to the conversation id during a stream.
  var streamingConv = null;

  // ---- storage helpers ----
  function skey(sfx) { return 'noola_' + sfx + '_' + KEY; }
  function loadJSON(k, fb) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  function loadIdentity() {
    var s = loadJSON(skey('ident'), null);
    if (s && typeof s === 'object') identity = { email: s.email || null, name: s.name || null, user_id: s.user_id || null, company: s.company || null, attributes: s.attributes || {} };
  }
  function saveIdentity() { saveJSON(skey('ident'), identity); }
  function isIdentified() { return !!(identity.email || identity.user_id); }

  function loadConvs() {
    convs = loadJSON(skey('convs'), null) || [];
    if (!convs.length) {
      // migrate the legacy single-conversation id (pre-multi-conversation widget)
      var legacy = null; try { legacy = localStorage.getItem('noola_conv_' + KEY); } catch (e) {}
      if (legacy) convs = [{ id: legacy, escalated: false, updatedAt: Date.now(), unread: 0, msgs: [] }];
    }
  }
  function saveConvs() {
    for (var i = 0; i < convs.length; i++) { if (convs[i].msgs && convs[i].msgs.length > 120) convs[i].msgs = convs[i].msgs.slice(-120); }
    saveJSON(skey('convs'), convs.slice(0, 20));
  }
  function uuid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('c' + Date.now() + Math.floor(Math.random() * 1e6)); }
  function getConv(id) { for (var i = 0; i < convs.length; i++) if (convs[i].id === id) return convs[i]; return null; }
  function newConv() { var c = { id: uuid(), escalated: false, updatedAt: Date.now(), unread: 0, msgs: [] }; convs.unshift(c); saveConvs(); return c; }
  function touchedConvs() {
    var out = []; for (var i = 0; i < convs.length; i++) if (convs[i].msgs && convs[i].msgs.length) out.push(convs[i]);
    out.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    return out;
  }
  // Pull an identified visitor's server-side conversation history into the local list, so a returning
  // user sees their past chats on the Messages tab (not just the ones this browser started). Each
  // server conversation becomes a stub with a one-line preview; opening it hydrates the full transcript.
  var serverConvsSynced = false;
  function syncServerConvs(cb) {
    if (!identity.email) { if (cb) cb(false); return; }
    fetch(API + '/public/conversations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: KEY, email: identity.email }) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.conversations) { if (cb) cb(false); return; }
        var changed = false;
        for (var i = 0; i < d.conversations.length; i++) {
          var sc = d.conversations[i];
          var at = +new Date(sc.updatedAt) || Date.now();
          var preview = sc.lastBody ? [{ role: sc.lastFromAgent ? 'agent' : 'me', id: 'preview', body: sc.lastBody, at: at }] : [];
          var existing = getConv(sc.conversationId);
          if (existing) {
            existing.escalated = sc.assistantEnabled === false;
            if (!existing.msgs.length && preview.length) { existing.msgs = preview; existing.updatedAt = at; changed = true; }
          } else {
            convs.push({ id: sc.conversationId, escalated: sc.assistantEnabled === false, updatedAt: at, unread: 0, msgs: preview });
            changed = true;
          }
        }
        if (changed) saveConvs();
        if (cb) cb(changed);
      })
      .catch(function () { if (cb) cb(false); });
  }
  function totalUnread() { var n = 0; for (var i = 0; i < convs.length; i++) n += (convs[i].unread || 0); return n; }

  // ---- shadow-DOM shell ----
  var host, root, styleEl, varStyle, wrapEl, bubbleEl, badgeEl, panelEl, stageEl;
  var curScreen = null;        // the live (front-most) screen; all queries scope to it
  var pendingDir = 'none';     // transition direction for the next render (set by setView/openPanel)
  var prevBadge = 0;

  // Queries scope to the active screen so a mid-transition outgoing screen (same ids) never matches.
  function sel(s) { return curScreen ? curScreen.querySelector(s) : null; }
  function selAll(s) { return curScreen ? curScreen.querySelectorAll(s) : []; }
  function reducedMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function relTime(ts) {
    var d = (Date.now() - ts) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    return Math.floor(d / 86400) + 'd ago';
  }

  var CSS =
    ':host,*{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}' +
    ':host{' +
      '--ease-out:cubic-bezier(0.23,1,0.32,1);--ease-drawer:cubic-bezier(0.32,0.72,0,1);' +
      '--ba-fg:#fff;--bg:#ffffff;--bg-sub:#f5f6f8;--elev:#ffffff;' +
      '--fg:#101623;--fg2:#5b6472;--fg3:#98a0ac;--bd:#e8eaee;--bd2:#dbdee4;' +
      '--ai-bg:color-mix(in srgb,var(--ba) 7%,#fff);--ai-bd:color-mix(in srgb,var(--ba) 20%,#e8eaee);' +
      '--me-fg:var(--ba-fg);--shadow:0 14px 44px rgba(16,24,40,.18);--shadow-sm:0 1px 2px rgba(16,24,40,.06);' +
      '--r:18px;--rb:16px;--rs:11px;color-scheme:light}' +
    '@media (prefers-color-scheme:dark){:host{' +
      '--bg:#15181d;--bg-sub:#0e1115;--elev:#1b1f25;' +
      '--fg:#e7e9ed;--fg2:#9aa2ad;--fg3:#697079;--bd:#282d34;--bd2:#363c45;' +
      '--ai-bg:color-mix(in srgb,var(--ba) 16%,#1b1f25);--ai-bd:color-mix(in srgb,var(--ba) 32%,#282d34);' +
      '--shadow:0 18px 52px rgba(0,0,0,.55);--shadow-sm:0 1px 2px rgba(0,0,0,.35);color-scheme:dark}}' +
    '.noola{position:fixed;bottom:0;right:0;z-index:2147483000}' +
    '.bubble{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;' +
      'background:var(--ba);color:var(--ba-fg);box-shadow:0 8px 24px rgba(0,0,0,.22);display:grid;place-items:center;z-index:2147483001;' +
      'transition:transform .18s var(--ease-out),box-shadow .18s var(--ease-out)}' +
    '.bubble:hover{box-shadow:0 10px 30px rgba(0,0,0,.28)}' +
    '.bubble:active{transform:scale(.94)}' +
    '.bubble .g{grid-area:1/1;display:grid;place-items:center;transition:opacity .18s var(--ease-out),transform .22s var(--ease-out)}' +
    '.bubble .g svg{width:26px;height:26px;display:block}' +
    '.bubble .gclose{opacity:0;transform:rotate(-90deg) scale(.5)}' +
    '.bubble.open .gchat{opacity:0;transform:rotate(90deg) scale(.5)}' +
    '.bubble.open .gclose{opacity:1;transform:none}' +
    '.pos-left .bubble{left:20px;right:auto}' +
    '.badge{position:fixed;bottom:56px;right:16px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#ef4444;color:#fff;' +
      'font-size:11px;font-weight:700;line-height:20px;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.25);z-index:2147483002;display:none}' +
    '.badge.pop{animation:badgepop .2s var(--ease-out)}' +
    '@keyframes badgepop{0%{transform:scale(.5)}60%{transform:scale(1.18)}100%{transform:scale(1)}}' +
    '.pos-left .badge{left:44px;right:auto}' +
    '.panel{position:fixed;bottom:88px;right:20px;width:400px;max-width:calc(100vw - 32px);height:min(680px,calc(100vh - 116px));' +
      'background:var(--bg);color:var(--fg);border-radius:var(--r);box-shadow:var(--shadow);display:none;flex-direction:column;' +
      'overflow:hidden;z-index:2147483001;transform-origin:bottom right;opacity:0;transform:translateY(10px) scale(.97);' +
      'transition:opacity .18s var(--ease-out),transform .18s var(--ease-out)}' +
    '@media (prefers-color-scheme:dark){.panel{border:1px solid var(--bd)}}' +
    '.pos-left .panel{left:20px;right:auto;transform-origin:bottom left}' +
    '.panel.on{opacity:1;transform:none;transition:opacity .24s var(--ease-out),transform .24s var(--ease-out)}' +
    '.stage{position:relative;flex:1;overflow:hidden;display:flex}' +
    '.screen{position:absolute;inset:0;display:flex;flex-direction:column;background:var(--bg);overflow:hidden}' +
    '.screen.enter-tab{opacity:0;transition:opacity .16s var(--ease-out)}' +
    '.screen.enter-tab.active{opacity:1}' +
    '.screen.leave-tab{transition:opacity .16s var(--ease-out)}' +
    '.screen.leave-tab.go{opacity:0}' +
    '.screen.enter-fwd{transform:translateX(100%);transition:transform .26s var(--ease-drawer)}' +
    '.screen.enter-fwd.active{transform:none}' +
    '.screen.leave-fwd{transition:transform .26s var(--ease-drawer),opacity .26s var(--ease-drawer)}' +
    '.screen.leave-fwd.go{transform:translateX(-24px);opacity:.55}' +
    '.screen.enter-back{transform:translateX(-24px);opacity:.55;transition:transform .26s var(--ease-drawer),opacity .26s var(--ease-drawer)}' +
    '.screen.enter-back.active{transform:none;opacity:1}' +
    '.screen.leave-back{z-index:2;transition:transform .26s var(--ease-drawer)}' +
    '.screen.leave-back.go{transform:translateX(100%)}' +
    '.hd{background:var(--ba);color:var(--ba-fg);padding:15px 15px 14px;display:flex;align-items:flex-start;gap:10px;position:relative}' +
    // Premium multi-stop mesh gradient (Intercom-style) instead of a flat accent bar.
    '.hd.grad{background:' +
      'radial-gradient(120% 140% at 0% 0%,color-mix(in srgb,var(--ba) 62%,#fff) 0%,transparent 55%),' +
      'radial-gradient(120% 130% at 100% 0%,color-mix(in srgb,var(--ba) 30%,#000) 0%,transparent 60%),' +
      'linear-gradient(150deg,color-mix(in srgb,var(--ba) 86%,#fff),var(--ba))}' +
    // Tall home header: oversized greeting + a decorative team-avatar cluster, top-right.
    '.hd.home{flex-direction:column;align-items:stretch;gap:0;padding:20px 18px 20px}' +
    '.hd.home .homeTop{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}' +
    '.hd.home .faces{display:flex;flex-direction:row-reverse}' +
    '.hd.home .faces .fc{width:34px;height:34px;border-radius:50%;margin-left:-10px;border:2px solid color-mix(in srgb,var(--ba) 70%,#000);background:rgba(255,255,255,.22);overflow:hidden;display:grid;place-items:center;color:var(--ba-fg)}' +
    '.hd.home .faces .fc img{width:100%;height:100%;object-fit:cover}.hd.home .faces .fc svg{width:17px;height:17px}' +
    '.hd.home h2{margin:18px 0 0;font-size:23px;line-height:1.18;font-weight:720;letter-spacing:-.02em}' +
    '.hd.home h2 .dim{opacity:.62}' +
    '.hd .htxt{min-width:0;flex:1}' +
    '.hd h3{margin:0;font-size:16.5px;font-weight:680;letter-spacing:-.012em;line-height:1.25}' +
    '.hd p{margin:3px 0 0;font-size:12.5px;opacity:.9;line-height:1.4}' +
    '.hd .iconbtn{background:rgba(255,255,255,.16);border:none;color:var(--ba-fg);width:30px;height:30px;border-radius:9px;cursor:pointer;display:grid;place-items:center;flex:0 0 auto;transition:background .15s var(--ease-out),transform .12s var(--ease-out)}' +
    '.hd .iconbtn:hover{background:rgba(255,255,255,.28)}' +
    '.hd .iconbtn:active{transform:scale(.93)}' +
    '.hd .iconbtn svg{width:18px;height:18px}' +
    '.hd-id{display:flex;align-items:center;gap:10px;min-width:0;flex:1}' +
    '.hd-id .idava{position:relative;flex:0 0 auto}' +
    '.hd-id .idava .av{width:38px;height:38px;border-radius:50%;overflow:hidden;background:rgba(255,255,255,.22);display:grid;place-items:center;color:var(--ba-fg);font-weight:680;font-size:15px}' +
    '.hd-id .idava .av img{width:100%;height:100%;object-fit:cover;display:block}' +
    '.hd-id .idava .av svg{width:20px;height:20px}' +
    '.hd-id .pres{position:absolute;right:-1px;bottom:-1px;width:11px;height:11px;border-radius:50%;background:#34d27b;box-shadow:0 0 0 2px var(--ba)}' +
    '.hd-id .idtxt{min-width:0}' +
    '.hd-id .idname{font-size:15px;font-weight:660;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.hd-id .idsub{font-size:12px;opacity:.9;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.body{flex:1;overflow-y:auto;background:var(--bg-sub)}' +
    '.tabbar{display:flex;border-bottom:1px solid var(--bd);background:var(--bg)}' +
    '.tabbar button{flex:1;border:none;background:none;cursor:pointer;padding:9px 4px 8px;display:flex;flex-direction:column;align-items:center;gap:2px;color:var(--fg3);font-size:11px;font-weight:600;transition:color .15s var(--ease-out)}' +
    '.tabbar button svg{width:20px;height:20px}' +
    '.tabbar button.act{color:var(--ba)}' +
    '.greet{padding:18px 16px 6px;font-size:14.5px;color:var(--fg2);line-height:1.5}' +
    '.card{background:var(--elev);border:1px solid var(--bd);border-radius:14px;box-shadow:var(--shadow-sm);margin:0 16px 12px}' +
    '.card-h{padding:14px 16px 6px;font-size:13px;font-weight:680;color:var(--fg)}' +
    '.rowlink{display:flex;align-items:center;gap:10px;padding:12px 16px;border-top:1px solid var(--bd);cursor:pointer;font-size:14px;color:var(--fg)}' +
    '.rowlink:first-child{border-top:none}' +
    '.rowlink:hover{background:var(--bg-sub)}' +
    '.rowlink .rt{min-width:0;flex:1}' +
    '.rowlink .rtitle{font-weight:560;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.rowlink .rsub{font-size:12px;color:var(--fg2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}' +
    '.rowlink .chev{color:var(--fg3);flex:0 0 auto;display:flex}' +
    '.rowlink .chev svg{width:16px;height:16px;display:block}' +
    '.dot{width:8px;height:8px;border-radius:50%;background:var(--ba);flex:0 0 auto}' +
    '.cta{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 16px 12px;padding:14px 16px;border-radius:14px;' +
      'background:var(--ba);color:var(--ba-fg);border:none;cursor:pointer;font-size:14px;font-weight:640;width:calc(100% - 32px);transition:transform .12s var(--ease-out),filter .15s var(--ease-out)}' +
    '.cta:hover{filter:brightness(1.06)}' +
    '.cta:active{transform:scale(.985)}' +
    '.cta svg{width:18px;height:18px}' +
    '.search{margin:0 16px 12px;display:flex;align-items:center;gap:8px;background:var(--elev);border:1px solid var(--bd);border-radius:12px;padding:9px 12px}' +
    '.search svg{width:16px;height:16px;color:var(--fg3);flex:0 0 auto}' +
    '.search input{flex:1;border:none;outline:none;font:inherit;font-size:14px;background:none;color:var(--fg)}' +
    '.sect{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--fg3);margin:16px 16px 6px}' +
    '.empty{padding:26px 20px;text-align:center;color:var(--fg2);font-size:13px}' +
    '.log{padding:16px 14px 12px;display:flex;flex-direction:column;gap:2px}' +
    '.mrow{display:flex;gap:8px;align-items:flex-end;max-width:100%}' +
    '.mrow.left{justify-content:flex-start}' +
    '.mrow.right{justify-content:flex-end}' +
    '.mrow+.mrow{margin-top:2px}' +
    '.mrow.gs{margin-top:13px}' +
    '.log>.mrow:first-child{margin-top:2px}' +
    '.mava{width:26px;height:26px;flex:0 0 auto;align-self:flex-end}' +
    '.mava .av{width:26px;height:26px;border-radius:50%;overflow:hidden;display:grid;place-items:center;font-size:10.5px;font-weight:680;color:#fff;background:var(--ba)}' +
    '.mava .av.ai{background:color-mix(in srgb,var(--ba) 88%,#000 6%)}' +
    '.mava .av img{width:100%;height:100%;object-fit:cover;display:block}' +
    '.mava .av svg{width:14px;height:14px;color:#fff}' +
    '.mstack{min-width:0;max-width:78%;display:flex;flex-direction:column;gap:3px}' +
    '.mrow.right .mstack{align-items:flex-end}' +
    '.mwho{font-size:11.5px;font-weight:600;color:var(--fg2);margin:0 0 1px 3px;display:flex;gap:6px;align-items:baseline}' +
    '.mwho .t{color:var(--fg3);font-weight:500;font-size:10.5px}' +
    '.rowm{padding:9px 13px;border-radius:var(--rb);font-size:14px;line-height:1.5;white-space:normal;word-wrap:break-word;overflow-wrap:anywhere;max-width:100%}' +
    '.rowm p{margin:0}.rowm p+p{margin-top:8px}' +
    '.rowm ul,.rowm ol{margin:6px 0;padding-left:20px}.rowm li{margin:2px 0}.rowm li::marker{color:var(--fg3)}' +
    '.rowm.me li::marker{color:rgba(255,255,255,.7)}' +
    '.rowm .mdh{font-weight:680;letter-spacing:-.01em;margin:8px 0 3px;font-size:14.5px}.rowm .mdh:first-child{margin-top:0}' +
    '.rowm em{font-style:italic}' +
    // Streaming: the live caret that trails the AI answer while tokens arrive; a soft blur-in as the
    // first token replaces the thinking dots so the two states blend rather than pop.
    '.rowm.streaming{animation:streamin .18s var(--ease-out)}' +
    '@keyframes streamin{from{filter:blur(2px);opacity:.5}to{filter:none;opacity:1}}' +
    '.caret{display:inline-block;width:2px;height:1.05em;margin-left:1px;vertical-align:-2px;border-radius:1px;background:var(--ba);opacity:.9;animation:caret 1s steps(1) infinite}' +
    '@keyframes caret{50%{opacity:0}}' +
    '.rowm.me{background:var(--ba);color:var(--me-fg)}' +
    '.rowm.agent{background:var(--elev);color:var(--fg);border:1px solid var(--bd)}' +
    '.rowm.ai{background:var(--ai-bg);color:var(--fg);border:1px solid var(--ai-bd)}' +
    '.mrow.left.gs .rowm{border-bottom-left-radius:5px}' +
    '.mrow.right.gs .rowm{border-bottom-right-radius:5px}' +
    '.rowm code{background:rgba(127,127,127,.16);border-radius:4px;padding:0 4px;font-size:.92em;font-family:ui-monospace,Menlo,Consolas,monospace}' +
    '.rowm.me code{background:rgba(255,255,255,.24)}' +
    '.rowm a{color:inherit;text-decoration:underline;text-underline-offset:2px}' +
    '.mrow.msg-enter{opacity:0;transform:translateY(7px);transition:opacity .22s var(--ease-out),transform .22s var(--ease-out)}' +
    '.mrow.msg-enter.in{opacity:1;transform:none}' +
    '.note{align-self:center;font-size:12px;color:var(--fg2);background:var(--bg-sub);border:1px solid var(--bd);border-radius:999px;padding:4px 12px;margin:11px 0 2px}' +
    '.src{align-self:flex-start;font-size:11px;color:var(--fg2);margin:-1px 0 0 34px}' +
    '.talk{align-self:flex-start;display:inline-flex;align-items:center;gap:6px;margin:13px 0 2px;padding:8px 13px;font-size:12.5px;' +
      'font-weight:560;color:var(--fg);background:var(--elev);border:1px solid var(--bd);border-radius:999px;cursor:pointer;box-shadow:var(--shadow-sm);' +
      'transition:background .15s var(--ease-out),border-color .15s var(--ease-out),transform .12s var(--ease-out)}' +
    '.talk:hover{background:var(--bg-sub);border-color:var(--bd2)}' +
    '.talk:active{transform:scale(.97)}' +
    '.talk svg{width:14px;height:14px;display:block;color:var(--ba)}' +
    '.think span{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--fg3);margin:0 1px;animation:bd 1s infinite}' +
    '.think span:nth-child(2){animation-delay:.15s}.think span:nth-child(3){animation-delay:.3s}' +
    '@keyframes bd{0%,100%{opacity:.3}50%{opacity:1}}' +
    '.foot{border-top:1px solid var(--bd);padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px;background:var(--bg)}' +
    '.footrow{display:flex;gap:6px;align-items:flex-end;background:var(--elev);border:1px solid var(--bd);border-radius:14px;padding:5px 5px 5px 7px;transition:border-color .15s var(--ease-out),box-shadow .15s var(--ease-out)}' +
    '.footrow:focus-within{border-color:color-mix(in srgb,var(--ba) 55%,var(--bd));box-shadow:0 0 0 3px color-mix(in srgb,var(--ba) 15%,transparent)}' +
    '.foot textarea{flex:1;resize:none;border:none;background:none;padding:7px 4px;font:inherit;font-size:14px;max-height:104px;outline:none;color:var(--fg);align-self:center}' +
    '.foot textarea::placeholder{color:var(--fg3)}' +
    '.foot button{border:none;background:var(--ba);color:var(--ba-fg);border-radius:10px;min-width:36px;height:36px;padding:0;font-weight:600;cursor:pointer;flex:0 0 auto;' +
      'display:grid;place-items:center;transition:transform .12s var(--ease-out),filter .15s var(--ease-out),opacity .15s var(--ease-out)}' +
    '.foot button:hover{filter:brightness(1.07)}' +
    '.foot button:active{transform:scale(.92)}' +
    '.foot button svg{width:18px;height:18px;display:block}' +
    '.foot button:disabled{opacity:.45;cursor:default}' +
    '.attbtn{background:none;color:var(--fg3);min-width:34px;height:34px}' +
    '.attbtn:hover{filter:none;background:var(--bg-sub);color:var(--fg2)}' +
    '.attbtn:active{transform:scale(.9)}' +
    '.attprev{display:flex;flex-wrap:wrap;gap:6px}' +
    '.attprev:empty{display:none}' +
    '.attchip{position:relative;display:flex;align-items:center;gap:6px;max-width:180px;border:1px solid var(--bd);border-radius:9px;padding:5px 8px;background:var(--bg-sub);font-size:12px;color:var(--fg2)}' +
    '.attchip img{width:26px;height:26px;border-radius:5px;object-fit:cover;flex:none}' +
    '.attchip svg{width:15px;height:15px;flex:none;color:var(--fg3)}' +
    '.attchip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.attchip .rm{position:absolute;top:-6px;right:-6px;width:17px;height:17px;min-width:0;padding:0;border-radius:50%;background:var(--fg);color:var(--bg);display:grid;place-items:center;cursor:pointer;border:none}' +
    '.attchip .rm svg{width:10px;height:10px;color:var(--bg)}' +
    '.rowm .att-img{display:block;margin-top:6px;border-radius:10px;overflow:hidden;max-width:200px;border:1px solid rgba(127,127,127,.18)}' +
    '.rowm .att-img img{display:block;max-width:100%;max-height:220px;object-fit:contain}' +
    '.rowm .att-file{display:flex;align-items:center;gap:7px;margin-top:6px;text-decoration:none;color:inherit;border:1px solid rgba(127,127,127,.24);border-radius:9px;padding:7px 10px;font-size:13px;max-width:220px}' +
    '.rowm.me .att-file{border-color:rgba(255,255,255,.35)}' +
    '.rowm .att-file svg{width:16px;height:16px;flex:none;opacity:.8}' +
    '.rowm .att-file span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.art{padding:18px 18px 28px;background:var(--bg);min-height:100%}' +
    '.art h1{font-size:19px;margin:0 0 12px;letter-spacing:-.01em;color:var(--fg)}' +
    '.art .art-body{font-size:14px;line-height:1.6;color:var(--fg2);white-space:pre-wrap;word-wrap:break-word}' +
    '.brand{padding:8px 16px 14px;text-align:center;font-size:11px;color:var(--fg3);background:var(--bg-sub)}' +
    // Thin, auto-hiding scrollbars in the shadow root — a native gray bar reads as "web page",
    // a hairline reads as "app". Firefox uses scrollbar-width; WebKit uses ::-webkit-scrollbar.
    '.body,.log,.art{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--fg3) 55%,transparent) transparent}' +
    '.body::-webkit-scrollbar,.log::-webkit-scrollbar,.art::-webkit-scrollbar{width:7px;height:7px}' +
    '.body::-webkit-scrollbar-thumb,.log::-webkit-scrollbar-thumb,.art::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--fg3) 45%,transparent);border-radius:99px;border:2px solid transparent;background-clip:padding-box}' +
    '.body:hover::-webkit-scrollbar-thumb,.log:hover::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--fg3) 70%,transparent);background-clip:padding-box}' +
    '.body::-webkit-scrollbar-track,.log::-webkit-scrollbar-track,.art::-webkit-scrollbar-track{background:transparent}' +
    // Send button: idle (disabled) is muted; "ready" (there is content) lifts to accent with a soft ring.
    '.foot button#send{background:var(--bd2);color:var(--fg3);transition:background .16s var(--ease-out),color .16s var(--ease-out),transform .12s var(--ease-out),box-shadow .16s var(--ease-out)}' +
    '.foot button#send.ready{background:var(--ba);color:var(--ba-fg);box-shadow:0 2px 8px color-mix(in srgb,var(--ba) 40%,transparent)}' +
    '.foot button#send.ready:hover{filter:brightness(1.07)}' +
    '.foot button#send:disabled{opacity:1;cursor:default}' +
    // Large image attachment tile in the composer (Intercom-style preview with a corner ✕).
    '.attthumb{position:relative;width:76px;height:76px;border-radius:12px;overflow:hidden;border:1px solid var(--bd);background:var(--bg-sub)}' +
    '.attthumb img{width:100%;height:100%;object-fit:cover;display:block}' +
    '.attthumb .rm{position:absolute;top:4px;right:4px;width:20px;height:20px;min-width:0;padding:0;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;display:grid;place-items:center;cursor:pointer;border:none;backdrop-filter:blur(2px)}' +
    '.attthumb .rm svg{width:11px;height:11px;color:#fff}' +
    // Quick-reply chips (suggested next actions under an AI answer).
    '.qrs{display:flex;flex-wrap:wrap;gap:7px;margin:9px 0 2px 34px}' +
    '.qr{border:1px solid var(--ai-bd);background:var(--elev);color:var(--ba);font:inherit;font-size:13px;font-weight:560;padding:7px 13px;border-radius:999px;cursor:pointer;transition:background .15s var(--ease-out),transform .12s var(--ease-out)}' +
    '.qr:hover{background:var(--ai-bg)}.qr:active{transform:scale(.97)}' +
    // Conversation-ended divider.
    '.ended{align-self:center;display:flex;align-items:center;gap:10px;width:calc(100% - 28px);margin:16px 0 6px;color:var(--fg3);font-size:12px}' +
    '.ended::before,.ended::after{content:"";flex:1;height:1px;background:var(--bd)}' +
    // Refined Home primary card: sparkle + label + trailing avatar cluster.
    '.askcard{display:flex;align-items:center;gap:12px;margin:0 16px 12px;padding:14px 15px;border-radius:15px;background:var(--elev);border:1px solid var(--bd);box-shadow:var(--shadow-sm);cursor:pointer;width:calc(100% - 32px);text-align:left;font:inherit;transition:transform .12s var(--ease-out),border-color .15s var(--ease-out),box-shadow .16s var(--ease-out)}' +
    '.askcard:hover{border-color:var(--bd2);box-shadow:0 4px 16px rgba(16,24,40,.08)}.askcard:active{transform:scale(.99)}' +
    '.askcard .ic{width:38px;height:38px;flex:0 0 auto;border-radius:11px;display:grid;place-items:center;background:var(--ai-bg);color:var(--ba)}.askcard .ic svg{width:20px;height:20px}' +
    '.askcard .at{flex:1;min-width:0}.askcard .att{font-weight:660;font-size:14.5px;color:var(--fg);letter-spacing:-.01em}.askcard .ats{font-size:12.5px;color:var(--fg2);margin-top:1px}' +
    '.askcard .chev{color:var(--fg3);flex:0 0 auto}.askcard .chev svg{width:18px;height:18px;display:block}' +
    '@media (prefers-reduced-motion:reduce){' +
      '.bubble,.bubble .g,.panel,.panel.on,.screen,.screen.enter-tab,.screen.enter-tab.active,.screen.enter-fwd,.screen.enter-fwd.active,' +
      '.screen.enter-back,.screen.enter-back.active,.screen.leave-tab,.screen.leave-fwd,.screen.leave-back,.mrow.msg-enter,.talk,.foot button{' +
        'transition:none!important;animation:none!important;transform:none!important;filter:none!important}' +
      '.screen.enter-tab,.screen.enter-back,.mrow.msg-enter,.panel.on{opacity:1!important}' +
      '.bubble.open .gchat{opacity:0!important}.bubble .gclose{opacity:0!important}.bubble.open .gclose{opacity:1!important}' +
      '.badge.pop{animation:none!important}}';

  function iconChat() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>'; }
  function iconClose() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'; }
  function iconBack() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>'; }
  function iconSearch() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>'; }
  function iconChev() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>'; }
  function iconHome() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5 12 3l9 6.5V21H3z"/></svg>'; }
  function iconMsgs() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/></svg>'; }
  function iconHelp() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>'; }
  function iconSend() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 5l7 7-7 7M21 12H3"/></svg>'; }
  function iconUser() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21a8 8 0 1 0-16 0"/><circle cx="12" cy="7" r="4"/></svg>'; }
  function iconSparkle() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5 10.1 7.6z"/></svg>'; }
  function iconClip() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.2 9.19a1 1 0 0 1-1.41-1.41l8.49-8.49"/></svg>'; }
  function iconFile() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>'; }
  function iconX() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>'; }

  function mount() {
    if (mounted) return;
    mounted = true;
    host = document.createElement('div');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
    root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

    styleEl = document.createElement('style'); styleEl.textContent = CSS; root.appendChild(styleEl);
    varStyle = document.createElement('style'); root.appendChild(varStyle);

    wrapEl = document.createElement('div');
    wrapEl.className = 'noola';
    wrapEl.innerHTML =
      '<button class="bubble" aria-label="Open messenger">' +
        '<span class="g gchat">' + iconChat() + '</span><span class="g gclose">' + iconClose() + '</span>' +
      '</button>' +
      '<span class="badge" aria-hidden="true"></span>' +
      '<div class="panel" role="dialog" aria-label="Support messenger"><div class="stage"></div></div>';
    root.appendChild(wrapEl);

    bubbleEl = wrapEl.querySelector('.bubble');
    badgeEl = wrapEl.querySelector('.badge');
    panelEl = wrapEl.querySelector('.panel');
    stageEl = panelEl.querySelector('.stage');
    bubbleEl.addEventListener('click', function () { panelOpen ? closePanel() : openPanel(); });

    applyConfig();
    renderBadge();
    resumeLive();
  }

  function applyConfig() {
    if (!varStyle) return;
    varStyle.textContent = ':host{--ba:' + CFG.accent + '}';
    wrapEl.className = 'noola' + (CFG.position === 'left' ? ' pos-left' : '');
    // keep the default view on an enabled tab
    var tabs = enabledTabs();
    if ((view === 'home' || view === 'messages' || view === 'help') && tabs.indexOf(view) === -1) view = tabs[0] || 'home';
  }

  function enabledTabs() {
    var t = []; if (CFG.tabs.home) t.push('home'); if (CFG.tabs.messages) t.push('messages'); if (CFG.tabs.help) t.push('help');
    if (!t.length) t.push('home');
    return t;
  }

  function renderBadge() {
    if (!badgeEl) return;
    var n = totalUnread();
    if (n > 0 && !panelOpen && !launcherHidden) {
      badgeEl.textContent = n > 9 ? '9+' : String(n);
      badgeEl.style.display = 'block';
      if (n !== prevBadge && !reducedMotion()) { badgeEl.classList.remove('pop'); void badgeEl.offsetWidth; badgeEl.classList.add('pop'); }
    } else badgeEl.style.display = 'none';
    prevBadge = n;
  }

  function openPanel() {
    mount();
    if (panelOpen) return;
    panelOpen = true;
    bubbleEl.classList.add('open');
    panelEl.style.display = 'flex';
    pendingDir = 'none';
    render();                       // build the first screen (no slide)
    void panelEl.offsetWidth;       // reflow so the enter transition runs from the closed state
    requestAnimationFrame(function () { if (panelOpen) panelEl.classList.add('on'); });
    renderBadge();
    // Fold in the identified visitor's server-side history once, so Home's recent card + Messages
    // reflect past chats from any device — then re-render the open view if anything was added.
    if (!serverConvsSynced && isIdentified()) {
      serverConvsSynced = true;
      syncServerConvs(function (changed) { if (changed && panelOpen) { pendingDir = 'none'; render(); } });
    }
  }
  function closePanel() {
    if (!panelOpen) return;
    panelOpen = false;
    if (bubbleEl) bubbleEl.classList.remove('open');
    if (panelEl) {
      panelEl.classList.remove('on');
      var p = panelEl;
      var hide = function () { if (!panelOpen) p.style.display = 'none'; };
      var t = setTimeout(hide, 260);
      p.addEventListener('transitionend', function te(e) {
        if (e.target === p) { p.removeEventListener('transitionend', te); clearTimeout(t); hide(); }
      });
    }
    renderBadge();
  }

  // Roots (tabbed) vs leaves (drilled-into) — decides the transition style.
  function isRoot(v) { return v === 'home' || v === 'messages' || v === 'help'; }
  function classifyDir(prev, next) {
    if (isRoot(prev) && !isRoot(next)) return 'forward';
    if (!isRoot(prev) && isRoot(next)) return 'back';
    if (!isRoot(prev) && !isRoot(next)) return 'forward';
    return 'tab';
  }

  function setView(v, arg) {
    pendingDir = classifyDir(view, v);
    view = v;
    if (v === 'thread') { threadId = arg; markRead(arg); }
    if (v === 'article') articleSlug = arg;
    render();
  }

  // ---- rendering ----
  function render() {
    if (!panelEl || !panelOpen || !stageEl) return;
    var built = view === 'thread' ? renderThread() : view === 'article' ? renderArticle() :
      view === 'messages' ? renderMessages() : view === 'help' ? renderHelp() : renderHome();
    var dir = pendingDir; pendingDir = 'none';
    var screen = document.createElement('div');
    screen.className = 'screen';
    screen.innerHTML = built.html;
    var outgoing = curScreen;
    stageEl.appendChild(screen);
    curScreen = screen;                 // wire against the new screen (sel/selAll)
    if (built.wire) built.wire();
    transitionScreens(screen, outgoing, dir);
    // live lane follows the open escalated thread
    if (view === 'thread') { var c = getConv(threadId); if (c && c.escalated) startLive(threadId); }
  }

  function transitionScreens(incoming, outgoing, dir) {
    if (!outgoing) return;              // first screen — nothing to cross with
    if (dir === 'none' || reducedMotion()) { if (outgoing.parentNode) outgoing.parentNode.removeChild(outgoing); return; }
    var enterCls = dir === 'forward' ? 'enter-fwd' : dir === 'back' ? 'enter-back' : 'enter-tab';
    var leaveCls = dir === 'forward' ? 'leave-fwd' : dir === 'back' ? 'leave-back' : 'leave-tab';
    incoming.classList.add(enterCls);
    outgoing.classList.add(leaveCls);
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      incoming.classList.add('active');
      outgoing.classList.add('go');
    }); });
    var done = false;
    function cleanup() {
      if (done) return; done = true;
      incoming.classList.remove(enterCls, 'active');
      if (outgoing.parentNode) outgoing.parentNode.removeChild(outgoing);
    }
    incoming.addEventListener('transitionend', function (e) { if (e.target === incoming && (e.propertyName === 'transform' || e.propertyName === 'opacity')) cleanup(); });
    setTimeout(cleanup, 360);          // fallback if transitionend is missed
  }

  function header(title, sub, opts) {
    opts = opts || {};
    var left = opts.back ? '<button class="iconbtn" id="bk" aria-label="Back">' + iconBack() + '</button>' : '';
    var h =
      '<div class="hd grad">' + left +
        '<div class="htxt"><h3>' + esc(title) + '</h3>' + (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div>' +
        '<button class="iconbtn" id="cl" aria-label="Close">' + iconClose() + '</button>' +
      '</div>';
    return h;
  }
  function wireHeader() {
    var cl = sel('#cl'); if (cl) cl.addEventListener('click', closePanel);
    var bk = sel('#bk'); if (bk) bk.addEventListener('click', function () { setView(backTarget()); });
  }
  function backTarget() { var t = enabledTabs(); return t.indexOf('messages') !== -1 ? 'messages' : t[0]; }

  function tabbar() {
    var tabs = enabledTabs();
    var icons = { home: iconHome, messages: iconMsgs, help: iconHelp }, labels = { home: 'Home', messages: 'Messages', help: 'Help' };
    if (tabs.length < 2) return '';
    var b = '<div class="tabbar">';
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      b += '<button data-tab="' + t + '" class="' + (view === t ? 'act' : '') + '">' + icons[t]() + '<span>' + labels[t] + '</span></button>';
    }
    return b + '</div>';
  }
  function wireTabs() {
    var btns = selAll('.tabbar button');
    for (var i = 0; i < btns.length; i++) (function (btn) {
      btn.addEventListener('click', function () { setView(btn.getAttribute('data-tab')); });
    })(btns[i]);
  }

  // The home header's stacked avatar cluster: the AI mark plus up to two real agent avatars the
  // visitor has actually talked to (from past conversations) — genuine faces, never fake stock.
  function homeFaces() {
    var urls = [], seen = {};
    for (var i = 0; i < convs.length; i++) {
      var ms = convs[i].msgs || [];
      for (var j = 0; j < ms.length; j++) {
        var u = ms[j] && ms[j].authorAvatarUrl;
        if (u && !seen[u]) { seen[u] = 1; urls.push(u); }
      }
    }
    urls = urls.slice(0, 2);
    var out = '<span class="fc">' + iconSparkle() + '</span>';
    for (var k = 0; k < urls.length; k++) out += '<span class="fc"><img src="' + esc(avatarUrl(urls[k])) + '" alt=""></span>';
    return out;
  }
  function renderHome() {
    var recent = touchedConvs()[0];
    var recentCard = '';
    if (recent) {
      var last = recent.msgs[recent.msgs.length - 1];
      recentCard =
        '<div class="card"><div class="rowlink" data-conv="' + esc(recent.id) + '">' +
          (recent.unread ? '<span class="dot"></span>' : '') +
          '<div class="rt"><div class="rtitle">Recent conversation</div><div class="rsub">' + esc((last && last.body) || '') + '</div></div>' +
          '<span class="chev">' + iconChev() + '</span>' +
        '</div></div>';
    }
    var hi = isIdentified() && identity.name ? esc(String(identity.name).split(/\s+/)[0]) : null;
    var homeHead =
      '<div class="hd grad home">' +
        '<div class="homeTop">' +
          '<div class="faces">' + homeFaces() + '</div>' +
          '<button class="iconbtn" id="cl" aria-label="Close">' + iconClose() + '</button>' +
        '</div>' +
        '<h2>' + (hi ? ('Hi ' + hi + '. ') : 'Hi there. ') + '<span class="dim">How can we help?</span></h2>' +
      '</div>';
    var html =
      homeHead + tabbar() +
      '<div class="body">' +
        '<div class="greet">' + esc(CFG.greeting) + '</div>' +
        '<button class="askcard" id="startc">' +
          '<span class="ic">' + iconSparkle() + '</span>' +
          '<span class="at"><span class="att">Ask a question</span><span class="ats">AI Agent &amp; team · instant answers</span></span>' +
          '<span class="chev">' + iconChev() + '</span>' +
        '</button>' +
        recentCard +
        (CFG.tabs.help ? (
          '<div class="search" id="hsearch"><span>' + iconSearch() + '</span><input id="hq" placeholder="Search for help" autocomplete="off"></div>' +
          '<div class="sect">Top articles</div><div id="tophelp"><div class="empty">Loading…</div></div>'
        ) : '') +
        '<div class="brand">Powered by Noola</div>' +
      '</div>';
    return { html: html, wire: function () {
      wireHeader(); wireTabs();
      var sc = sel('#startc'); if (sc) sc.addEventListener('click', openOrStartConversation);
      var rc = sel('.rowlink[data-conv]'); if (rc) rc.addEventListener('click', function () { setView('thread', rc.getAttribute('data-conv')); });
      var hq = sel('#hq'); if (hq) hq.addEventListener('keydown', function (e) { if (e.key === 'Enter') { helpSeed = hq.value; setView('help'); } });
      if (CFG.tabs.help) loadTopArticles();
    } };
  }
  function loadTopArticles() {
    fetchKB('/public/kb').then(function (d) {
      var el = sel('#tophelp'); if (!el) return;
      var arts = (d && d.articles) || [];
      if (!arts.length) { el.innerHTML = '<div class="empty">No articles yet.</div>'; return; }
      el.innerHTML = '<div class="card">' + arts.slice(0, 4).map(articleRow).join('') + '</div>';
      wireArticleRows(el);
    }).catch(function () { var el = sel('#tophelp'); if (el) el.innerHTML = ''; });
  }
  function articleRow(a) {
    return '<div class="rowlink" data-slug="' + esc(a.slug) + '"><div class="rt"><div class="rtitle">' + esc(a.title) + '</div></div><span class="chev">' + iconChev() + '</span></div>';
  }
  function wireArticleRows(scope) {
    var rows = scope.querySelectorAll('.rowlink[data-slug]');
    for (var i = 0; i < rows.length; i++) (function (r) { r.addEventListener('click', function () { setView('article', r.getAttribute('data-slug')); }); })(rows[i]);
  }

  function renderMessages() {
    var list = touchedConvs();
    var rows = list.length ? list.map(function (c) {
      var last = c.msgs[c.msgs.length - 1];
      return '<div class="rowlink" data-conv="' + esc(c.id) + '">' +
        (c.unread ? '<span class="dot"></span>' : '') +
        '<div class="rt"><div class="rtitle">' + esc((last && last.body) || 'Conversation') + '</div>' +
        '<div class="rsub">' + esc(c.escalated ? 'With the team' : 'AI assistant') + ' · ' + relTime(c.updatedAt || Date.now()) + '</div></div>' +
        '<span class="chev">' + iconChev() + '</span></div>';
    }).join('') : '';
    var html =
      header('Messages') + tabbar() +
      '<div class="body">' +
        '<button class="cta" id="startc" style="margin-top:16px"><span>Start a new conversation</span>' + iconSend() + '</button>' +
        (rows ? '<div class="card">' + rows + '</div>' : '<div class="empty">No conversations yet.<br>Start one above.</div>') +
      '</div>';
    return { html: html, wire: function () {
      wireHeader(); wireTabs();
      var sc = sel('#startc'); if (sc) sc.addEventListener('click', startConversation);
      var rows2 = selAll('.rowlink[data-conv]');
      for (var i = 0; i < rows2.length; i++) (function (r) { r.addEventListener('click', function () { setView('thread', r.getAttribute('data-conv')); }); })(rows2[i]);
      // First visit to Messages: pull the identified visitor's server history, then re-render the list
      // once if it added anything (guard flag prevents a render loop).
      if (!serverConvsSynced) {
        serverConvsSynced = true;
        syncServerConvs(function (changed) { if (changed && view === 'messages') { pendingDir = 'none'; render(); } });
      }
    } };
  }

  function openOrStartConversation() { var r = touchedConvs()[0]; if (r) setView('thread', r.id); else startConversation(); }
  function startConversation() { var c = newConv(); setView('thread', c.id); }

  // The contents of the message log for a conversation — intro (fresh AI convo only), the message
  // rows, and the mode toggle. Factored out so a live hydrate can rebuild #log in place without a
  // full screen re-render (keeps the composer + scroll steady).
  // Avatar identity for a left-side (agent/AI) message. AI answers post as an agent with no
  // author_id (see /public/conversation) — we render them with a sparkle glyph, humans with their
  // uploaded avatar or initials, so the visitor can always tell the AI from a person.
  function initials(name) {
    if (!name) return '';
    var p = String(name).trim().split(/\s+/);
    var a = (p[0] || '')[0] || '';
    var b = p.length > 1 ? ((p[p.length - 1] || '')[0] || '') : '';
    return (a + b).toUpperCase();
  }
  // Agent avatar_url is stored API-relative ('/avatar/<uuid>.jpg', served by the API's public
  // GET /avatar/*). The widget lives on a THIRD-PARTY origin, so a bare '/avatar/...' would resolve
  // against the customer's own site (404). Prefix it with the API base the widget booted from.
  function avatarUrl(u) { return (u && u.charAt(0) === '/') ? API + u : u; }
  function avatarInner(m) {
    if (m.role === 'ai') return '<span class="av ai">' + iconSparkle() + '</span>';
    if (m.authorAvatarUrl) return '<span class="av"><img src="' + esc(avatarUrl(m.authorAvatarUrl)) + '" alt=""></span>';
    var ini = initials(m.authorName);
    return '<span class="av">' + (ini ? esc(ini) : iconUser()) + '</span>';
  }
  function whoName(m) { return m.role === 'ai' ? 'AI Assistant' : (m.authorName || 'Support'); }
  function sideOf(m) { return m.role === 'me' ? 'right' : 'left'; }
  // Group consecutive turns from the same author (Intercom-style): one avatar + name per run.
  function groupKey(m) { return m.role === 'me' ? 'me' : m.role === 'ai' ? 'ai' : ('agent:' + (m.authorName || m.authorAvatarUrl || '')); }
  // One message row. Left rows carry an avatar column + a name/time label on the first of a group;
  // continuation rows keep an empty avatar spacer so bubbles stay aligned. Right rows (the visitor)
  // never show an avatar. system 'note' lines are centered; empty rows are skipped by the caller.
  function mrowHtml(m, gs, at) {
    if (m.role === 'note') return '<div class="note">' + esc(m.body) + '</div>';
    if (m.role === 'src') return '<div class="src">' + esc(m.body) + '</div>';
    var cls = m.role === 'me' ? 'me' : m.role === 'agent' ? 'agent' : 'ai';
    var atts = (m.attachments && m.attachments.length) ? m.attachments.map(attHtml).join('') : '';
    var onlyFiles = atts && m.attachments.map(function (a) { return a.filename; }).join(', ') === m.body;
    var body = (m.body && !onlyFiles) ? md(m.body) : '';
    var bubble = '<div class="rowm ' + cls + '">' + body + atts + '</div>';
    if (m.role === 'me') return '<div class="mrow right' + (gs ? ' gs' : '') + '"><div class="mstack">' + bubble + '</div></div>';
    var ava = '<div class="mava">' + (gs ? avatarInner(m) : '') + '</div>';
    var who = gs ? '<div class="mwho">' + esc(whoName(m)) + (at ? ' <span class="t">' + esc(relTime(at)) + '</span>' : '') + '</div>' : '';
    return '<div class="mrow left' + (gs ? ' gs' : '') + '">' + ava + '<div class="mstack">' + who + bubble + '</div></div>';
  }
  function threadLogHtml(c) {
    var out = '';
    if (!c.msgs.length && !c.escalated) {
      out += mrowHtml({ role: 'ai', body: 'Hi! Ask me anything and I’ll answer instantly from our knowledge base. Prefer a person? Use “Talk to a human” below.' }, true, null);
    }
    var prev = null;
    for (var i = 0; i < c.msgs.length; i++) {
      var m = c.msgs[i];
      // Skip empty rows (no body AND no attachments) so a stray empty bubble can never render.
      var hasAtt = m.attachments && m.attachments.length;
      if (m.role !== 'note' && m.role !== 'src' && (!m.body || !String(m.body).trim()) && !hasAtt) continue;
      var side = sideOf(m);
      var gs = !prev || sideOf(prev) !== side || groupKey(prev) !== groupKey(m) || (m.at && prev.at && (m.at - prev.at > 5 * 60 * 1000));
      out += mrowHtml(m, gs, m.at);
      prev = m;
    }
    // A resolved/closed ticket shows an "ended" divider (Intercom-style) above the toggle; the
    // visitor can still ask again, which reopens the thread server-side on the next turn.
    if (c.status === 'resolved' || c.status === 'closed') out += '<div class="ended">This conversation has ended</div>';
    // One toggle, driven by the authoritative AI mode: mute the bot ("Talk to a human") or turn it
    // back on ("Ask the assistant"). Always present so the visitor is never stuck in one mode.
    var toggle = c.escalated
      ? '<button class="talk" id="resume" type="button">' + iconSparkle() + '<span>Ask the assistant</span></button>'
      : '<button class="talk" id="talk" type="button">' + iconUser() + '<span>Talk to a human</span></button>';
    return out + toggle;
  }
  function refreshLog(convId) {
    if (!(panelOpen && view === 'thread' && threadId === convId)) return;
    var c = getConv(convId); if (!c) return;
    var log = sel('#log'); if (!log) return;
    var atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.innerHTML = threadLogHtml(c);
    wireThreadLog(c);
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  function wireThreadLog(c) {
    var talkb = sel('#talk'); if (talkb) talkb.addEventListener('click', function () { escalate(c.id); });
    var resumeb = sel('#resume'); if (resumeb) resumeb.addEventListener('click', function () { resumeAssistant(c.id); });
  }
  // Pull the authoritative transcript from the server and reconcile the local copy to it, so the
  // widget shows EXACTLY what the agent console shows (single source of truth). Only rebuilds the DOM
  // when the message set actually changed (by id) or the AI mode flipped — most polls are no-ops.
  function hydrateThread(convId, cb) {
    // Don't reconcile a conversation whose AI answer is mid-stream — the persisted answer doesn't
    // exist yet, so rebuilding from the server would erase the live streaming bubble.
    if (streamingConv === convId) { if (cb) cb(); return; }
    fetch(API + '/public/conversation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: KEY, conversationId: convId }) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var c = getConv(convId); if (!c || !d) { if (cb) cb(); return; }
        var wasEsc = !!c.escalated;
        c.escalated = d.assistantEnabled === false;
        c.status = d.status || null;
        var server = (d.messages || []).map(function (m) { return { role: m.role === 'agent' ? 'agent' : m.role === 'ai' ? 'ai' : 'me', id: m.id, body: m.body, attachments: m.attachments || [], at: m.at ? +new Date(m.at) : Date.now(), authorName: m.authorName || null, authorAvatarUrl: m.authorAvatarUrl || null }; });
        var localIds = c.msgs.map(function (m) { return m.id || ''; }).join('|');
        var serverIds = server.map(function (m) { return m.id; }).join('|');
        var changed = localIds !== serverIds;
        if (changed) {
          // If the visitor isn't looking at this thread, count freshly-arrived agent/AI turns as unread
          // for the launcher badge (a background poll reconciles silently otherwise).
          var viewing = panelOpen && view === 'thread' && threadId === convId;
          if (!viewing) {
            var known = {}; for (var i = 0; i < c.msgs.length; i++) if (c.msgs[i].id) known[c.msgs[i].id] = 1;
            var fresh = 0; for (var j = 0; j < server.length; j++) if ((server[j].role === 'agent' || server[j].role === 'ai') && !known[server[j].id]) fresh++;
            if (fresh) { c.unread = (c.unread || 0) + fresh; renderBadge(); }
          }
          c.msgs = server; c.updatedAt = Date.now();
        }
        var viewingNow = panelOpen && view === 'thread' && threadId === convId;
        if (wasEsc !== c.escalated) {
          // Mode flipped — the header subtitle AND the toggle both change, so re-render the whole
          // thread screen (refreshLog only owns #log, which would leave the header stale).
          saveConvs();
          if (viewingNow) { pendingDir = 'none'; render(); }
        } else if (changed) {
          saveConvs(); refreshLog(convId);
        }
        if (cb) cb();
      })
      .catch(function () { if (cb) cb(); });
  }

  // Thread header with a human/AI identity block (avatar + presence + status) instead of a bare
  // title — the surface the visitor is actually talking to. Shows the latest human agent in the
  // thread if there is one, else the AI assistant. Reuses the #bk/#cl ids that wireHeader() binds.
  function threadHeader(c) {
    var back = enabledTabs().length > 1;
    var agent = null; for (var i = c.msgs.length - 1; i >= 0; i--) { if (c.msgs[i].role === 'agent') { agent = c.msgs[i]; break; } }
    var name, avInner, sub;
    if (c.escalated) {
      name = agent ? (agent.authorName || 'Support') : 'Our team';
      avInner = agent ? avatarInner(agent) : '<span class="av">' + iconUser() + '</span>';
      sub = 'Connected · we’ll reply here';
    } else {
      name = agent ? (agent.authorName || 'Support') : 'AI Assistant';
      avInner = agent ? avatarInner(agent) : '<span class="av ai">' + iconSparkle() + '</span>';
      sub = 'Replies instantly · talk to a human anytime';
    }
    return '<div class="hd grad">' +
      (back ? '<button class="iconbtn" id="bk" aria-label="Back">' + iconBack() + '</button>' : '') +
      '<div class="hd-id"><div class="idava">' + avInner + '<span class="pres"></span></div>' +
        '<div class="idtxt"><div class="idname">' + esc(name) + '</div><div class="idsub">' + esc(sub) + '</div></div></div>' +
      '<button class="iconbtn" id="cl" aria-label="Close">' + iconClose() + '</button>' +
    '</div>';
  }
  function renderThread() {
    var c = getConv(threadId) || newConv();
    threadId = c.id;
    var html =
      threadHeader(c) +
      '<div class="body"><div class="log" id="log">' + threadLogHtml(c) + '</div></div>' +
      '<div class="foot">' +
        '<div class="attprev" id="attprev"></div>' +
        '<div class="footrow">' +
          '<button class="attbtn" id="attach" type="button" aria-label="Attach a file">' + iconClip() + '</button>' +
          '<textarea id="q" rows="1" placeholder="Type a message…"></textarea>' +
          '<button id="send" type="button" aria-label="Send message">' + iconSend() + '</button>' +
          '<input type="file" id="fileinput" multiple accept="image/*,.pdf,.txt,.csv,.doc,.docx,.zip,.log" style="display:none">' +
        '</div>' +
      '</div>';
    return { html: html, wire: function () {
      wireHeader();
      pending = [];                              // fresh composer per thread open
      var q = sel('#q'), send = sel('#send');
      var log = sel('#log'); if (log) log.scrollTop = log.scrollHeight;
      wireThreadLog(c);
      send.addEventListener('click', function () { sendMsg(c.id); });
      q.addEventListener('input', function () { q.style.height = 'auto'; q.style.height = Math.min(q.scrollHeight, 96) + 'px'; syncSendState(); });
      q.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(c.id); } });
      var attach = sel('#attach'), fi = sel('#fileinput');
      if (attach && fi) attach.addEventListener('click', function () { fi.click(); });
      if (fi) fi.addEventListener('change', function () { addFiles(fi.files); fi.value = ''; });
      renderAttPrev();
      syncSendState();
      q.focus();
      // Reconcile against the server on open, then keep the thread live (poll + WS) regardless of mode
      // so agent replies AND AI answers stream in and both interfaces stay in lockstep.
      hydrateThread(c.id);
      startLive(c.id);
    } };
  }

  // ---- composer attachments (pending until the message is sent) ----
  var pending = [];              // [{ dataUrl, filename, contentType, isImage }]
  var ATT_MAX_BYTES = 15 * 1024 * 1024, ATT_MAX_COUNT = 5;
  function addFiles(fileList) {
    if (!fileList) return;
    for (var i = 0; i < fileList.length; i++) {
      if (pending.length >= ATT_MAX_COUNT) break;
      (function (file) {
        if (!file || file.size === 0 || file.size > ATT_MAX_BYTES) return;
        var r = new FileReader();
        r.onload = function () {
          pending.push({ dataUrl: String(r.result), filename: file.name || 'file', contentType: file.type || 'application/octet-stream', isImage: (file.type || '').indexOf('image/') === 0 });
          renderAttPrev();
        };
        r.readAsDataURL(file);
      })(fileList[i]);
    }
  }
  function renderAttPrev() {
    var box = sel('#attprev'); if (!box) return;
    box.innerHTML = pending.map(function (p, i) {
      // Images get a large tile preview (Intercom-style); other files a compact chip.
      if (p.isImage) {
        return '<span class="attthumb"><img src="' + p.dataUrl + '" alt="' + esc(p.filename) + '">' +
          '<button class="rm" type="button" data-i="' + i + '" aria-label="Remove">' + iconX() + '</button></span>';
      }
      return '<span class="attchip">' + iconFile() + '<span>' + esc(p.filename) + '</span>' +
        '<button class="rm" type="button" data-i="' + i + '" aria-label="Remove">' + iconX() + '</button></span>';
    }).join('');
    var rms = box.querySelectorAll('.rm');
    for (var k = 0; k < rms.length; k++) (function (b) { b.addEventListener('click', function () { pending.splice(+b.getAttribute('data-i'), 1); renderAttPrev(); syncSendState(); }); })(rms[k]);
  }
  // XSS-safe markdown for chat bubbles: a small line parser (headings, bullet/ordered lists,
  // paragraphs) with inline bold / italic / code / links. Everything is escaped BEFORE any markup
  // is added, so no user/model text can inject HTML. AI answers come back in markdown; rendering it
  // is what makes an answer read as a crafted reply instead of a wall of asterisks.
  function mdInline(t) {
    t = esc(t);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>');
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return t;
  }
  function md(s) {
    var text = String(s == null ? '' : s);
    var lines = text.split('\n');
    var html = '', listType = null, para = [];
    function flushPara() { if (para.length) { html += '<p>' + para.join('<br>') + '</p>'; para = []; } }
    function closeList() { if (listType) { html += '</' + listType + '>'; listType = null; } }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var h = /^(#{1,3})\s+(.*)$/.exec(ln);
      var ul = /^\s*[-*]\s+(.*)$/.exec(ln);
      var ol = /^\s*\d+\.\s+(.*)$/.exec(ln);
      if (h) { flushPara(); closeList(); html += '<div class="mdh">' + mdInline(h[2]) + '</div>'; }
      else if (ul) { flushPara(); if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; } html += '<li>' + mdInline(ul[1]) + '</li>'; }
      else if (ol) { flushPara(); if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; } html += '<li>' + mdInline(ol[1]) + '</li>'; }
      else if (!ln.trim()) { flushPara(); closeList(); }
      else { closeList(); para.push(mdInline(ln)); }
    }
    flushPara(); closeList();
    return html || esc(text);
  }
  // A message attachment, served from the scoped public lane (key + conversation handle). Images
  // render inline; everything else is a downloadable file chip.
  function attHtml(a) {
    var isImg = a.contentType && a.contentType.indexOf('image/') === 0 && a.contentType !== 'image/svg+xml';
    // Optimistic (just-picked) attachment: no server id yet — show the local data URL, no link.
    if (a._local) {
      if (isImg) return '<span class="att-img"><img src="' + a._local + '" alt="' + esc(a.filename) + '"></span>';
      return '<span class="att-file">' + iconFile() + '<span>' + esc(a.filename) + '</span></span>';
    }
    var url = API + '/public/attachment/' + encodeURIComponent(a.id) + '?key=' + encodeURIComponent(KEY) + '&cid=' + encodeURIComponent(threadId);
    if (isImg) return '<a class="att-img" href="' + url + '" target="_blank" rel="noopener"><img src="' + url + '" alt="' + esc(a.filename) + '" loading="lazy"></a>';
    return '<a class="att-file" href="' + url + '" target="_blank" rel="noopener" download>' + iconFile() + '<span>' + esc(a.filename) + '</span></a>';
  }
  // Standalone single row (optimistic sends + error line). The next hydrate re-renders the whole
  // log with proper grouping, so a lone row only needs to look right on its own → treat as group-start.
  function msgHtml(m) { return mrowHtml(m, true, m.at); }
  function appendMsg(convId, m, live) {
    var c = getConv(convId); if (!c) return;
    c.msgs.push(m); c.updatedAt = Date.now(); saveConvs();
    if (panelOpen && view === 'thread' && threadId === convId) {
      var log = sel('#log');
      if (log) {
        var wrap = document.createElement('div'); wrap.innerHTML = msgHtml(m);
        var node = wrap.firstChild;
        var animate = !reducedMotion() && (m.role === 'me' || m.role === 'agent' || m.role === 'ai');
        if (animate && node.classList) node.classList.add('msg-enter');
        var talk = log.querySelector('.talk');
        if (talk && (m.role === 'me' || m.role === 'agent' || m.role === 'ai')) log.insertBefore(node, talk);
        else log.appendChild(node);
        log.scrollTop = log.scrollHeight;
        if (animate && node.classList) requestAnimationFrame(function () { requestAnimationFrame(function () { node.classList.add('in'); }); });
      }
    } else if (live && (m.role === 'agent')) {
      c.unread = (c.unread || 0) + 1; saveConvs(); renderBadge();
    }
  }
  function markRead(convId) { var c = getConv(convId); if (c && c.unread) { c.unread = 0; saveConvs(); renderBadge(); } }

  function sendMsg(convId) {
    var c = getConv(convId); if (!c) return;
    var q = sel('#q'); if (!q) return;
    var text = q.value.trim();
    var files = pending.slice();
    if ((!text && !files.length) || busy) return;   // nothing to send
    q.value = ''; q.style.height = 'auto';
    pending = []; renderAttPrev();
    // Optimistic bubble: show the text plus local previews of the just-picked files (hydrate then
    // swaps them for the persisted, server-served attachments).
    var optAtts = files.map(function (f) { return { id: null, filename: f.filename, contentType: f.contentType, _local: f.dataUrl }; });
    appendMsg(convId, { role: 'me', body: text, attachments: optAtts, at: Date.now() });
    var send = sel('#send'); busy = true; if (send) send.disabled = true;

    // The server decides who answers from the conversation's authoritative AI mode: in AI mode it
    // replies; in human mode (or an attachment-only turn) it just persists the message for the team.
    // We never pass an escalate flag here — a plain message in human mode is simply queued to the agent.
    var body = { key: KEY, question: text, conversationId: convId };
    if (files.length) body.attachments = files.map(function (f) { return { dataUrl: f.dataUrl, filename: f.filename }; });
    if (identity.email) body.email = identity.email;
    if (identity.name) body.name = identity.name;
    var unbusy = function () { busy = false; var sb = sel('#send'); if (sb) sb.disabled = false; syncSendState(); var qq = sel('#q'); if (qq) qq.focus(); };
    trackActivity('conversation_message', { conversationId: convId });

    // AI-mode text turns stream the answer token-by-token over SSE (perceived-instant). Human mode,
    // escalated threads, and attachment-only turns keep the plain /public/ask lane (nothing to stream).
    if (!c.escalated && text) { streamAiAnswer(convId, body, unbusy); return; }

    fetch(API + '/public/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      // Render nothing by hand — pull the persisted turn(s) from the server so the widget shows
      // exactly what the agent console shows (single source of truth, no duplicate/again bubbles).
      .then(function () { hydrateThread(convId); })
      .catch(function () { appendMsg(convId, { role: 'ai', body: 'Sorry — something went wrong. Please try again.', at: Date.now() }); })
      .finally(unbusy);
  }

  // ---- SSE streaming of the AI answer -------------------------------------
  // Read a POST Server-Sent-Events response frame-by-frame. Handlers: onEvent(name,data) per SSE
  // frame, onJson(obj) if the server answered non-stream JSON (deferred/not-AI), onError(err).
  function streamSSE(url, body, h) {
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var ct = res.headers.get('content-type') || '';
        if (ct.indexOf('text/event-stream') === -1) {
          return res.json().then(function (j) { if (h.onJson) h.onJson(j); }).catch(function () { if (h.onError) h.onError(); });
        }
        if (!res.body || !res.body.getReader) {   // no streaming reader → read whole, then parse frames
          return res.text().then(function (txt) { parseFrames(txt, h); });
        }
        var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) { if (buf.trim()) emitFrame(buf, h); return; }
            buf += dec.decode(r.value, { stream: true });
            var idx;
            while ((idx = buf.indexOf('\n\n')) >= 0) { var f = buf.slice(0, idx); buf = buf.slice(idx + 2); emitFrame(f, h); }
            return pump();
          });
        }
        return pump();
      })
      .catch(function (e) { if (h.onError) h.onError(e); });
  }
  function emitFrame(frame, h) {
    var event = 'message', data = '';
    var lines = frame.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (ln.indexOf('event:') === 0) event = ln.slice(6).trim();
      else if (ln.indexOf('data:') === 0) data += ln.slice(5).trim();
    }
    if (!data) return;                         // ':' heartbeat comments carry no data
    var parsed = null; try { parsed = JSON.parse(data); } catch (e) {}
    if (h.onEvent) h.onEvent(event, parsed);
  }
  function parseFrames(txt, h) { var fs = txt.split('\n\n'); for (var i = 0; i < fs.length; i++) if (fs[i].trim()) emitFrame(fs[i], h); }

  // Stream an AI answer into the log: thinking-dots → a live bubble that fills token-by-token with a
  // caret, then on 'done' stamp the server message id (so poll/WS never double-render) and reconcile.
  function streamAiAnswer(convId, body, done) {
    var log = sel('#log');
    var thinking = null, bubbleRow = null, bubble = null, acc = '', raf = 0, doneCalled = false, stick = true;
    var msg = { role: 'ai', id: null, body: '', at: Date.now() };
    streamingConv = convId;
    if (log) {
      thinking = document.createElement('div');
      thinking.innerHTML = '<div class="mrow left gs"><div class="mava"><span class="av ai">' + iconSparkle() + '</span></div><div class="mstack"><div class="rowm ai think"><span></span><span></span><span></span></div></div></div>';
      log.appendChild(thinking); log.scrollTop = log.scrollHeight;
    }
    function atBottom() { return log ? (log.scrollHeight - log.scrollTop - log.clientHeight < 60) : true; }
    function paint() {
      raf = 0; if (!bubble) return;
      bubble.innerHTML = md(acc) + '<span class="caret"></span>';
      if (stick && log) log.scrollTop = log.scrollHeight;
    }
    function mount() {
      if (thinking && thinking.parentNode) thinking.parentNode.removeChild(thinking); thinking = null;
      var wrap = document.createElement('div');
      wrap.innerHTML = '<div class="mrow left gs"><div class="mava"><span class="av ai">' + iconSparkle() + '</span></div><div class="mstack"><div class="mwho">' + esc('AI Assistant') + '</div><div class="rowm ai streaming"></div></div></div>';
      bubbleRow = wrap.firstChild;
      if (!reducedMotion() && bubbleRow.classList) bubbleRow.classList.add('msg-enter');
      if (log) { var talk = log.querySelector('.talk'); if (talk) log.insertBefore(bubbleRow, talk); else log.appendChild(bubbleRow); }
      bubble = bubbleRow.querySelector('.rowm');
      if (!reducedMotion() && bubbleRow.classList) requestAnimationFrame(function () { requestAnimationFrame(function () { bubbleRow.classList.add('in'); }); });
    }
    function onDelta(t) { if (!bubble) mount(); stick = atBottom(); acc += t; if (!raf) raf = requestAnimationFrame(paint); }
    function commit(id) {
      var c = getConv(convId);
      msg.body = acc; msg.id = id || ('s' + Date.now());
      if (c) { c.msgs.push(msg); c.updatedAt = Date.now(); saveConvs(); }
    }
    function finish(id) {
      if (doneCalled) return; doneCalled = true; streamingConv = null;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (bubble) bubble.classList.remove('streaming');
      if (bubble) bubble.innerHTML = md(acc);      // drop the caret
      if (acc) commit(id);
      hydrateThread(convId);                       // reconcile now that the answer is persisted
      if (done) done();
    }
    function fail() {
      if (doneCalled) return; doneCalled = true; streamingConv = null;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (thinking && thinking.parentNode) thinking.parentNode.removeChild(thinking);
      if (acc) { if (bubble) { bubble.classList.remove('streaming'); bubble.innerHTML = md(acc); } commit(null); }
      else { if (bubbleRow && bubbleRow.parentNode) bubbleRow.parentNode.removeChild(bubbleRow); appendMsg(convId, { role: 'ai', body: 'Sorry — something went wrong. Please try again.', at: Date.now() }); }
      if (done) done();
    }
    streamSSE(API + '/public/ask/stream', body, {
      onEvent: function (event, data) {
        if (event === 'delta') { if (data && data.t) onDelta(data.t); }
        else if (event === 'done') finish(data && data.messageId);
        else if (event === 'error') fail();
      },
      onJson: function () { streamingConv = null; if (thinking && thinking.parentNode) thinking.parentNode.removeChild(thinking); hydrateThread(convId); if (done) done(); },
      onError: fail
    });
  }

  // Enable/lift the send button only when there's something to send (text or a pending attachment)
  // and we're not mid-request — the Intercom "send lights up" affordance.
  function syncSendState() {
    var q = sel('#q'), send = sel('#send'); if (!send) return;
    var has = !!((q && q.value.trim()) || pending.length);
    send.disabled = busy || !has;
    if (send.classList) send.classList.toggle('ready', has && !busy);
  }

  // Human handoff: mute the assistant on this conversation (server-authoritative, set before the
  // handoff message is ingested so no bot reply races it) and post a customer-side marker that
  // surfaces the thread in the agents' "needs reply" queue — the full AI transcript stays on the
  // same ticket. UI reflects the new mode once the server has confirmed it (no optimistic race).
  function escalate(convId) {
    var c = getConv(convId); if (!c || c.escalated || busy) return;
    var b = { key: KEY, question: 'I’d like to talk to a human, please.', conversationId: convId, escalate: true };
    if (identity.email) b.email = identity.email;
    if (identity.name) b.name = identity.name;
    trackActivity('requested_human', { conversationId: convId });
    fetch(API + '/public/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
      .then(function () {
        c.escalated = true; saveConvs();
        if (view === 'thread' && threadId === convId) { pendingDir = 'none'; render(); }
        startLive(convId);
      })
      .catch(function () {});
  }

  // Bring the AI back ("Ask the assistant"): un-mute the assistant server-side, then reflect it. The
  // whole transcript is intact on the ticket, so the AI answers the next question with full context.
  function resumeAssistant(convId) {
    var c = getConv(convId); if (!c || !c.escalated || busy) return;
    fetch(API + '/public/assistant-mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: KEY, conversationId: convId, enabled: true }) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function () {
        c.escalated = false; saveConvs();
        if (view === 'thread' && threadId === convId) { pendingDir = 'none'; render(); var qq = sel('#q'); if (qq) qq.focus(); }
      })
      .catch(function () {});
  }

  // ---- live lane (poll + WS) scoped to one escalated conversation ----
  function resumeLive() {
    // on load, keep the newest escalated conversation live so unread accrues while closed
    var esc2 = null; for (var i = 0; i < convs.length; i++) if (convs[i].escalated) { if (!esc2 || (convs[i].updatedAt || 0) > (esc2.updatedAt || 0)) esc2 = convs[i]; }
    if (esc2) startLive(esc2.id);
  }
  function startLive(convId) {
    if (activeConvId !== convId) { stopPoll(); closeWS(); activeConvId = convId; }
    if (!pollTimer) { poll(); pollTimer = setInterval(poll, 6000); }
    connectWS();
  }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  // A live agent/AI message arrived over the socket. If the visitor is looking at that thread, pull
  // the authoritative transcript (single render path); otherwise record it as unread for the badge.
  function onAgent(convId, id, bodyTxt) {
    var c = getConv(convId); if (!c) return;
    if (panelOpen && view === 'thread' && threadId === convId) { hydrateThread(convId); return; }
    var mkey = id || ('b' + bodyTxt);
    for (var i = 0; i < c.msgs.length; i++) if (c.msgs[i].id === mkey) return; // dedupe poll <-> socket
    c.msgs.push({ role: 'agent', id: mkey, body: bodyTxt, at: Date.now() });
    c.unread = (c.unread || 0) + 1; c.updatedAt = Date.now(); saveConvs(); renderBadge();
  }
  // Poll = reconcile the open thread against the server (customer + agent + AI, correctly ordered).
  function poll() { if (activeConvId) hydrateThread(activeConvId); }
  function connectWS() {
    if (!EDGE || ws || !activeConvId) return;
    var topic = 'widget:' + activeConvId;
    var url = EDGE + '/widget-socket/websocket?vsn=2.0.0&key=' + encodeURIComponent(KEY);
    try { ws = new WebSocket(url); } catch (e) { ws = null; return; }
    ws.onopen = function () {
      ws.send(JSON.stringify(['1', '1', topic, 'phx_join', { key: KEY }]));
      wsHb = setInterval(function () { if (ws && ws.readyState === 1) ws.send(JSON.stringify([null, 'hb' + (++wsRef), 'phoenix', 'heartbeat', {}])); }, 30000);
    };
    ws.onmessage = function (ev) { var f; try { f = JSON.parse(ev.data); } catch (e) { return; } if (f && f[2] === topic && f[3] === 'message' && f[4]) onAgent(activeConvId, f[4].id, f[4].body); };
    ws.onclose = function () { if (wsHb) { clearInterval(wsHb); wsHb = null; } ws = null; if (activeConvId) setTimeout(connectWS, 3000); };
    ws.onerror = function () { try { ws && ws.close(); } catch (e) {} };
  }
  function closeWS() { if (wsHb) { clearInterval(wsHb); wsHb = null; } if (ws) { try { ws.close(); } catch (e) {} ws = null; } }

  // ---- Help center ----
  var helpTimer = null;
  function renderHelp() {
    var html =
      header('Help center', 'Search our knowledge base') + tabbar() +
      '<div class="body">' +
        '<div class="search" style="margin-top:16px"><span>' + iconSearch() + '</span><input id="hq" placeholder="Search for articles" autocomplete="off"></div>' +
        '<div id="hres"><div class="sect">Browse</div><div id="hbrowse"><div class="empty">Loading…</div></div></div>' +
      '</div>';
    return { html: html, wire: function () {
      wireHeader(); wireTabs();
      var hq = sel('#hq');
      if (typeof helpSeed === 'string' && helpSeed) { hq.value = helpSeed; runHelpSearch(helpSeed); helpSeed = null; }
      else loadBrowse();
      hq.addEventListener('input', function () { if (helpTimer) clearTimeout(helpTimer); var v = hq.value; helpTimer = setTimeout(function () { runHelpSearch(v); }, 250); });
      hq.focus();
    } };
  }
  var helpSeed = null;
  function loadBrowse() {
    fetchKB('/public/kb').then(function (d) {
      var el = sel('#hbrowse'); if (!el) return;
      var arts = (d && d.articles) || [];
      if (!arts.length) { el.innerHTML = '<div class="empty">No articles published yet.</div>'; return; }
      el.innerHTML = '<div class="card">' + arts.map(articleRow).join('') + '</div>';
      wireArticleRows(el);
    }).catch(function () {});
  }
  function runHelpSearch(q) {
    q = (q || '').trim();
    var res = sel('#hres'); if (!res) return;
    if (q.length < 2) { res.innerHTML = '<div class="sect">Browse</div><div id="hbrowse"></div>'; loadBrowse(); return; }
    fetchKB('/public/kb/search?q=' + encodeURIComponent(q)).then(function (d) {
      var arts = (d && d.articles) || [];
      res.innerHTML = '<div class="sect">' + arts.length + ' result' + (arts.length === 1 ? '' : 's') + '</div>' +
        (arts.length ? '<div class="card">' + arts.map(articleRow).join('') + '</div>' : '<div class="empty">No matching articles.</div>');
      wireArticleRows(res);
    }).catch(function () {});
  }

  function renderArticle() {
    var html =
      header('Article', null, { back: true }) +
      '<div class="body"><div class="art" id="art"><div class="empty">Loading…</div></div></div>';
    return { html: html, wire: function () {
      wireHeader();
      var bk = sel('#bk'); if (bk) { bk.onclick = function () { setView('help'); }; }
      fetchKB('/public/kb/' + encodeURIComponent(articleSlug)).then(function (d) {
        var el = sel('#art'); if (!el) return;
        var a = d && d.article;
        if (!a) { el.innerHTML = '<div class="empty">Article not found.</div>'; return; }
        el.innerHTML = '<h1>' + esc(a.title) + '</h1><div class="art-body">' + esc(a.body || a.content || '') + '</div>';
      }).catch(function () { var el = sel('#art'); if (el) el.innerHTML = '<div class="empty">Couldn’t load this article.</div>'; });
    } };
  }

  function fetchKB(path) {
    var sep = path.indexOf('?') === -1 ? '?' : '&';
    return fetch(API + path + sep + 'key=' + encodeURIComponent(KEY)).then(function (r) { return r.ok ? r.json() : null; });
  }

  // ---- config bootstrap ----
  function loadConfig() {
    if (configLoaded || !KEY) return;
    fetch(API + '/public/config?key=' + encodeURIComponent(KEY)).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      configLoaded = true;
      if (d && d.config) {
        var c = d.config;
        if (c.accent) CFG.accent = c.accent;
        if (c.title) CFG.title = c.title;
        if (c.greeting) CFG.greeting = c.greeting;
        if (c.position) CFG.position = c.position;
        if (c.tabs) CFG.tabs = { home: !!c.tabs.home, messages: !!c.tabs.messages, help: !!c.tabs.help };
      }
      applyConfig();
      if (panelOpen) render();
    }).catch(function () {});
  }

  // ---- identity / activity SDK plumbing ----
  var KNOWN = { key: 1, api: 1, api_base: 1, email: 1, name: 1, user_id: 1, userId: 1, company: 1 };
  function ingestIdentity(opts) {
    if (!opts || typeof opts !== 'object') return;
    if (typeof opts.email === 'string') identity.email = opts.email;
    if (typeof opts.name === 'string') identity.name = opts.name;
    var uid = opts.user_id != null ? opts.user_id : opts.userId;
    if (uid != null) identity.user_id = String(uid);
    if (typeof opts.company === 'string') identity.company = opts.company;
    for (var k in opts) { if (opts.hasOwnProperty(k) && !KNOWN[k]) identity.attributes[k] = opts[k]; }
    saveIdentity();
  }
  function currentPage() { return { url: location.href, title: document.title }; }
  function sendIdentify(extra) {
    if (!isIdentified() || !KEY) return;
    var attrs = {}; for (var k in identity.attributes) if (identity.attributes.hasOwnProperty(k)) attrs[k] = identity.attributes[k];
    if (extra) for (var k2 in extra) if (extra.hasOwnProperty(k2)) attrs[k2] = extra[k2];
    fetch(API + '/public/identify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      key: KEY, email: identity.email || undefined, name: identity.name || undefined, user_id: identity.user_id || undefined,
      company: identity.company || undefined, attributes: attrs, page: currentPage()
    }) }).catch(function () {});
  }
  function trackActivity(name, metadata) {
    if (!isIdentified() || !KEY) return;
    fetch(API + '/public/track', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      key: KEY, email: identity.email || undefined, user_id: identity.user_id || undefined, name: name, metadata: metadata || {}
    }) }).catch(function () {});
  }

  var navTimer = null, lastUrl = location.href, activityHooked = false;
  function recordPageView() {
    sendIdentify();
    trackActivity('viewed_page', currentPage());
  }
  function hookActivity() {
    if (activityHooked) return; activityHooked = true;
    function onNav() {
      if (location.href === lastUrl) return; lastUrl = location.href;
      if (navTimer) clearTimeout(navTimer);
      navTimer = setTimeout(recordPageView, 800);
    }
    ['pushState', 'replaceState'].forEach(function (m) {
      var orig = history[m]; if (typeof orig === 'function') history[m] = function () { var r = orig.apply(this, arguments); onNav(); return r; };
    });
    window.addEventListener('popstate', onNav);
    window.addEventListener('hashchange', onNav);
  }

  // ---- public SDK dispatcher: window.Noola(cmd, a, b) ----
  function dispatch(cmd, a, b) {
    switch (cmd) {
      case 'boot': {
        if (a && a.key) KEY = String(a.key);
        if (a && (a.api || a.api_base)) API = String(a.api || a.api_base).replace(/\/+$/, '');
        if (!KEY) { console.warn('[noola] boot: missing key'); return; }
        loadIdentity(); ingestIdentity(a || {}); loadConvs();
        mount(); loadConfig();
        if (!launcherHidden && bubbleEl) bubbleEl.style.display = 'grid';
        hookActivity(); recordPageView();
        break;
      }
      case 'update': { ingestIdentity(a || {}); sendIdentify(); break; }
      case 'track': { if (typeof a === 'string' && a) trackActivity(a, b || {}); break; }
      case 'show': { launcherHidden = false; mount(); if (bubbleEl) bubbleEl.style.display = 'grid'; renderBadge(); break; }
      case 'hide': { launcherHidden = true; closePanel(); if (bubbleEl) bubbleEl.style.display = 'none'; if (badgeEl) badgeEl.style.display = 'none'; break; }
      case 'open': { openPanel(); break; }
      case 'close': { closePanel(); break; }
      case 'shutdown': {
        try { localStorage.removeItem(skey('ident')); localStorage.removeItem(skey('convs')); } catch (e) {}
        identity = { email: null, name: null, user_id: null, company: null, attributes: {} };
        convs = []; threadId = null; activeConvId = null; stopPoll(); closeWS();
        closePanel(); renderBadge();
        break;
      }
      default: console.warn('[noola] unknown command: ' + cmd);
    }
  }

  // Drain any queue captured by the loader snippet before this script ran, then go live.
  var existing = window.Noola;
  var queued = (existing && existing.q) ? existing.q.slice() : [];
  var hadBoot = false;
  window.Noola = function () { dispatch.apply(null, [].slice.call(arguments)); };
  window.Noola.q = [];
  for (var i = 0; i < queued.length; i++) { if (queued[i] && queued[i][0] === 'boot') hadBoot = true; dispatch.apply(null, [].slice.call(queued[i])); }

  // Plain <script data-noola-key> embed (no boot call) → auto-boot anonymously so the widget
  // shows up exactly as before, and background activity/identity plumbing is ready if a later
  // Noola('boot',{...}) identifies the visitor.
  if (!hadBoot && KEY) {
    loadIdentity(); loadConvs();
    mount(); loadConfig();
    hookActivity(); recordPageView();
  }
})();`;
