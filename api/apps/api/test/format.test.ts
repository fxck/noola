import { mdToSlack, mdToTelegramHtml, mdToWhatsApp, mdToPlain } from "../src/channels/format.js";

// Per-channel markdown adaptation (channels/format.ts) — pure transforms, no DB. Pins the
// syntax each surface actually renders: Slack mrkdwn, Telegram HTML, WhatsApp single-marker,
// plain-text stripping. The composed broadcast shape (**subject**\n\nbody) is the headline case.

let failures = 0;
function check(name: string, cond: boolean, got?: string) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}${got !== undefined ? ` — got: ${JSON.stringify(got)}` : ""}`);
  }
}

// ---- Slack (mrkdwn) ----
{
  const s = mdToSlack("**Launch day**\n\nHello *there* — read [the docs](https://x.test/a_b) and ~~old~~ new.\n- one\n- two");
  check("slack: **bold** → *bold*", s.includes("*Launch day*") && !s.includes("**"), s);
  check("slack: *italic* → _italic_", s.includes("_there_"), s);
  check("slack: links → <url|text>", s.includes("<https://x.test/a_b|the docs>"), s);
  check("slack: strike → ~x~", s.includes("~old~"), s);
  check("slack: list dashes → bullets", s.includes("• one") && s.includes("• two"), s);
  check("slack: heading → bold line", mdToSlack("## Title").trim() === "*Title*", mdToSlack("## Title"));
  check("slack: inline code untouched", mdToSlack("run `npm i` now").includes("`npm i`"));
  check("slack: plain text passes through", mdToSlack("just a plain sentence.") === "just a plain sentence.");
}

// ---- Telegram (HTML) ----
{
  const t = mdToTelegramHtml("**Launch day**\n\nHello *there*, see [docs](https://x.test) & use `a<b`.");
  check("telegram: bold → <b>", t.includes("<b>Launch day</b>"), t);
  check("telegram: italic → <i>", t.includes("<i>there</i>"), t);
  check("telegram: link → <a href>", t.includes('<a href="https://x.test">docs</a>'), t);
  check("telegram: & escaped", t.includes("&amp;"), t);
  check("telegram: code escaped inside <code>", t.includes("<code>a&lt;b</code>"), t);
  const fence = mdToTelegramHtml("```js\nif (a<b) x();\n```");
  check("telegram: fence → <pre> escaped", fence.includes("<pre>") && fence.includes("a&lt;b"), fence);
}

// ---- WhatsApp ----
{
  const w = mdToWhatsApp("**Launch day**\n\n_soft_ [docs](https://x.test) ~~old~~\n- item");
  check("whatsapp: **bold** → *bold*", w.includes("*Launch day*") && !w.includes("**"), w);
  check("whatsapp: link → text (url)", w.includes("docs (https://x.test)"), w);
  check("whatsapp: strike → ~x~", w.includes("~old~"), w);
  check("whatsapp: italic underscores kept", w.includes("_soft_"), w);
  check("whatsapp: bullets", w.includes("• item"), w);
}

// ---- Plain ----
{
  const p = mdToPlain("**Big** _news_: [read](https://x.test) `code` and\n```\nfence\n```");
  check("plain: all markers stripped", !/[*_`#[\]]/.test(p.replace("https://x.test", "")), p);
  check("plain: link keeps label + url", p.includes("read (https://x.test)"), p);
  check("plain: code content survives", p.includes("code") && p.includes("fence"), p);
}

// ---- the broadcast chat shape ----
{
  const md = "**What's new this month**\n\nWe shipped **templates** — details [here](https://x.test).";
  check("broadcast shape (slack)", mdToSlack(md).startsWith("*What's new this month*"), mdToSlack(md));
  check("broadcast shape (telegram)", mdToTelegramHtml(md).startsWith("<b>What&#39;s new this month</b>") || mdToTelegramHtml(md).startsWith("<b>What's new this month</b>"), mdToTelegramHtml(md));
  check("broadcast shape (whatsapp)", mdToWhatsApp(md).startsWith("*What's new this month*"), mdToWhatsApp(md));
}

if (failures > 0) {
  console.error(`\nFORMAT: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nFORMAT: all checks green");
