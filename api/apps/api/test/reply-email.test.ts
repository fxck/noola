import { renderReplyEmail } from "../src/emails/reply-email.js";

// Reply-template gate: markdown renders to real HTML (bold/list), the plaintext
// alternative is markdown-stripped, the restrained footer is present in both, and
// the signature line appears ONLY when an agentName is supplied. Pure render — no
// network, no DB.

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}`);
  }
}

const FOOTER = "Sent with Noola · Reply to this email to continue the conversation.";

async function main() {
  const md = "Hi there, **thanks** for reaching out.\n\n- restart the app\n- clear the cache";

  // ---- default render (no agent name) ----
  {
    const { html, text } = await renderReplyEmail(md);
    check("html renders markdown bold to <strong>", /<strong[\s>]/.test(html) && html.includes("thanks"));
    check("html renders markdown list to <li>", /<li[\s>]/.test(html) && html.includes("restart the app"));
    check("html carries the footer line", html.includes(FOOTER));
    check("text is markdown-stripped (no ** or list markers)", !text.includes("**") && !/^- /m.test(text));
    check("text keeps the message content", text.includes("thanks") && text.includes("restart the app"));
    check("text carries the footer line", text.includes(FOOTER));
    check("no signature without agentName", !html.includes("— "));
  }

  // ---- signature only when agentName provided ----
  {
    const withName = await renderReplyEmail(md, { agentName: "Dana" });
    check("signature rendered when agentName set", withName.html.includes("— Dana") && withName.text.includes("— Dana"));
    const nullName = await renderReplyEmail(md, { agentName: null });
    check("null agentName renders no signature", !nullName.html.includes("— "));
  }

  // ---- empty body still renders (placeholder) ----
  {
    const { html } = await renderReplyEmail("");
    check("empty body renders the placeholder", html.includes("(no content)"));
  }

  if (failures > 0) { console.error(`\nREPLY-EMAIL: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nREPLY-EMAIL: all checks green");
}

main().catch((e) => { console.error("reply-email seam ERROR", e); process.exit(1); });
