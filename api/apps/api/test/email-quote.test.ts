import { stripInboundQuote } from "../src/email-quote.js";

// Inbound quote/signature stripping. Pure function — no DB, no network. Each case feeds a
// realistic reply from a specific mail client and asserts we keep ONLY what the customer typed
// this turn, that the quoted history lands in `quoted`, and that we NEVER blank a message.

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function main() {
  // ---- the exact reported case: Apple/Gmail "On <date> … wrote:" attribution ----
  {
    const body = [
      "I don't speak your language",
      "",
      "On 11 August 2026 at 21:00:43, Aleš from Zerops (support@zerops.io) wrote:",
      "",
      "asdasdasd ada sdas da sdas d asdasd",
      "",
      "— Aleš",
      "----------------------------",
      "",
      "Reply to this email to continue the conversation.",
    ].join("\n");
    const { visible, quoted } = stripInboundQuote({ text: body });
    check("attribution: keeps only the new line", visible === "I don't speak your language");
    check("attribution: quote preserved in meta", !!quoted && quoted.includes("asdasdasd ada sdas"));
    check("attribution: our footer did not leak into visible", !visible.includes("Reply to this email"));
  }

  // ---- attribution wrapped across two lines (address on line 1, "wrote:" on line 2) ----
  {
    const body = [
      "Thanks, that fixed it!",
      "",
      "On Mon, Aug 11, 2026 at 9:00 PM Aleš <support@zerops.io>",
      "wrote:",
      "> here is the previous message",
      "> second quoted line",
    ].join("\n");
    const { visible, quoted } = stripInboundQuote({ text: body });
    check("wrapped attribution: keeps the reply", visible === "Thanks, that fixed it!");
    check("wrapped attribution: quote captured", !!quoted && quoted.includes("here is the previous message"));
  }

  // ---- bare '>' quoting with no attribution line ----
  {
    const body = ["new answer here", "", "> your earlier question", "> more of it"].join("\n");
    const { visible } = stripInboundQuote({ text: body });
    check("angle-quote: cut at first '>'", visible === "new answer here");
  }

  // ---- Outlook "-----Original Message-----" divider ----
  {
    const body = [
      "See my reply above.",
      "",
      "-----Original Message-----",
      "From: Support <support@zerops.io>",
      "Sent: Monday",
      "Subject: Re: ticket",
      "",
      "old content",
    ].join("\n");
    const { visible, quoted } = stripInboundQuote({ text: body });
    check("outlook divider: keeps reply", visible === "See my reply above.");
    check("outlook divider: quote captured", !!quoted && quoted.includes("old content"));
  }

  // ---- Outlook header block WITHOUT a dashed divider (From:/Sent:/To:) ----
  {
    const body = [
      "Please find my response.",
      "",
      "From: Support <support@zerops.io>",
      "Sent: Monday, August 11, 2026",
      "To: me",
      "Subject: Re: your ticket",
      "",
      "quoted body",
    ].join("\n");
    const { visible } = stripInboundQuote({ text: body });
    check("outlook header block: keeps reply", visible === "Please find my response.");
  }

  // ---- localized attribution (Czech "Dne … napsal(a):") — this workspace is CZ ----
  {
    const body = [
      "Díky za odpověď.",
      "",
      "Dne 11. 8. 2026 v 21:00 Aleš <support@zerops.io> napsal(a):",
      "> předchozí zpráva",
    ].join("\n");
    const { visible, quoted } = stripInboundQuote({ text: body });
    check("czech attribution: keeps reply", visible === "Díky za odpověď.");
    check("czech attribution: quote captured", !!quoted && quoted.includes("předchozí zpráva"));
  }

  // ---- localized attribution (German "Am … schrieb …:") ----
  {
    const body = [
      "Danke, das hilft.",
      "",
      "Am 11.08.2026 um 21:00 schrieb Aleš <support@zerops.io>:",
      "> vorherige Nachricht",
    ].join("\n");
    const { visible } = stripInboundQuote({ text: body });
    check("german attribution: keeps reply", visible === "Danke, das hilft.");
  }

  // ---- trailing "-- " signature is stripped off the visible fragment ----
  {
    const body = ["Here is my question.", "", "-- ", "Jane Doe", "CTO, Acme"].join("\n");
    const { visible, quoted } = stripInboundQuote({ text: body });
    check("signature: kept out of visible", visible === "Here is my question.");
    check("signature: preserved in quoted", !!quoted && quoted.includes("Jane Doe"));
  }

  // ---- no quote at all → body passes through untouched, quoted is null ----
  {
    const body = "Just a plain first message with no history.";
    const { visible, quoted } = stripInboundQuote({ text: body });
    check("no-quote: body unchanged", visible === body);
    check("no-quote: nothing quoted", quoted === null);
  }

  // ---- refuse to blank: a bare forward (attribution on the very first line) ----
  {
    const body = ["On Mon, Aug 11 2026, X <x@y.com> wrote:", "> the whole thing is a quote"].join("\n");
    const { visible } = stripInboundQuote({ text: body });
    check("never-blank: keeps original when a cut would empty it", visible.length > 0);
  }

  // ---- HTML-only email (no plaintext part): structural excision of a gmail_quote container ----
  {
    const html =
      '<div dir="ltr">My HTML-only reply</div>' +
      '<div class="gmail_quote"><blockquote type="cite">quoted original message</blockquote></div>';
    const { visible, quoted } = stripInboundQuote({ text: "", html });
    check("html-only: keeps the reply text", visible === "My HTML-only reply");
    check("html-only: drops the quoted block from visible", !visible.includes("quoted original"));
    check("html-only: quote preserved", !!quoted && quoted.includes("quoted original"));
  }

  // ---- HTML-only Apple Mail blockquote type="cite" ----
  {
    const html =
      '<div>Reply body</div><br><blockquote type="cite"><div>On date, someone wrote:</div><div>old text</div></blockquote>';
    const { visible } = stripInboundQuote({ text: "", html });
    check("html apple-mail: keeps reply, drops cite", visible === "Reply body");
  }

  // ---- prefers plaintext when both parts exist (text is the cleaner signal) ----
  {
    const text = "Plain reply\n\nOn Aug 11, 2026, X wrote:\n> quoted";
    const html = "<div>Plain reply</div><blockquote>quoted</blockquote>";
    const { visible } = stripInboundQuote({ text, html });
    check("both-parts: uses plaintext path", visible === "Plain reply");
  }

  if (failures) { console.error(`\nEMAIL-QUOTE: ${failures} check(s) failed`); process.exit(1); }
  console.log("\nEMAIL-QUOTE: all checks green");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
