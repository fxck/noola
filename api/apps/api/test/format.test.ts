import { mdToSlack, mdToTelegramHtml, mdToWhatsApp, mdToPlain, normalizeBlockquotes, discordTokensToText, plainThreadName } from "../src/channels/format.js";

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

// ---- blockquote normalization (Discord/CommonMark-vs-Lexical fold) ----
{
  // Discord "quote the question, answer below": the answer must NOT fold into the quote.
  const q = normalizeBlockquotes("> question\nanswer");
  check("bq: blank line inserted after a quote before text", q === "> question\n\nanswer", q);

  // Interspersed quote/text/quote/text becomes four distinct blocks.
  const inter = normalizeBlockquotes("> q1\nt1\n> q2\nt2");
  check("bq: quote/text/quote/text separated", inter === "> q1\n\nt1\n\n> q2\n\nt2", inter);

  // Consecutive quote lines stay ONE quote (no blank inserted between them).
  const multi = normalizeBlockquotes("> a\n> b\nc");
  check("bq: consecutive quote lines stay grouped", multi === "> a\n> b\n\nc", multi);

  // Idempotent — already-separated input is unchanged.
  const already = "> q\n\ntext";
  check("bq: idempotent on separated input", normalizeBlockquotes(already) === already, normalizeBlockquotes(already));

  // No blockquote → untouched (fast path).
  check("bq: plain text untouched", normalizeBlockquotes("just text\nmore text") === "just text\nmore text");

  // A `>` inside a fenced code block is not treated as a quote boundary.
  const fenced = "```\n> not a quote\ncode\n```\nafter";
  check("bq: fenced code left alone", normalizeBlockquotes(fenced) === fenced, normalizeBlockquotes(fenced));
}

// ── Discord tokens in inbound text ──
{
  const t = (s: string) => discordTokensToText(s);
  check("dc: custom emoji → :name:", t("hi <:pepe:123456789> and <a:dance:987654321>") === "hi :pepe: and :dance:", t("hi <:pepe:123456789> and <a:dance:987654321>"));
  check("dc: timestamp → fixed UTC time", t("at <t:1792954800:F> ok") === "at 25 Oct 2026 19:00 UTC ok", t("at <t:1792954800:F> ok"));
  check("dc: bare timestamp", t("<t:1792954800>") === "25 Oct 2026 19:00 UTC", t("<t:1792954800>"));
  check("dc: slash-command mention → /cmd sub", t("run </ask question:1234567890>") === "run /ask question", t("run </ask question:1234567890>"));
  check("dc: subtext marker dropped", t("text\n-# small print") === "text\nsmall print", t("text\n-# small print"));
  check("dc: markdown is kept", t("**bold** and [link](https://x.io)") === "**bold** and [link](https://x.io)");
  check("dc: code spans are left alone", t("`<:pepe:123>`") === "`<:pepe:123>`");
  check("dc: a 12-digit or millisecond timestamp stays as it is", t("<t:999999999999>") === "<t:999999999999>" && t("<t:1792954800000>") === "<t:1792954800000>", t("<t:999999999999>"));
}

// ── plain-text thread names ──
{
  check("tn: markdown and links stripped", plainThreadName("**Login** _broken_ on [the app](https://x.io)") === "Login broken on the app", plainThreadName("**Login** _broken_ on [the app](https://x.io)"));
  check("tn: snake_case survives", plainThreadName("error in user_id field") === "error in user_id field");
  check("tn: spoilers stay hidden", plainThreadName("my password is ||hunter2||") === "my password is [spoiler]");
  check("tn: newlines and quote markers collapse", plainThreadName("> quoted\nline two") === "quoted line two", plainThreadName("> quoted\nline two"));
  check("tn: emoji token readable", plainThreadName("help <:sad:123>") === "help :sad:");
  check("tn: inline code is shown literally", plainThreadName("crash in `__init__.py`") === "crash in __init__.py", plainThreadName("crash in `__init__.py`"));
  check("tn: nested quote markers are stripped", plainThreadName("> > deep quote") === "deep quote", plainThreadName("> > deep quote"));
  const long = "The dashboard keeps crashing whenever I open the reports page after the latest update rolled out yesterday";
  const name = plainThreadName(long);
  check("tn: cut on a word boundary with ...", name.length <= 80 && name.endsWith("...") && long.startsWith(name.slice(0, -3)) && long[name.length - 3] === " ", name);
  const exact = "a".repeat(10) + " " + "b".repeat(66) + " cc dd";
  check("tn: a cut that already ends a word keeps the whole word", plainThreadName(exact) === `${"a".repeat(10)} ${"b".repeat(66)}...`, plainThreadName(exact));
  check("tn: one huge word is hard-cut", plainThreadName("x".repeat(200)).length === 80);
}

if (failures > 0) {
  console.error(`\nFORMAT: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nFORMAT: all checks green");
