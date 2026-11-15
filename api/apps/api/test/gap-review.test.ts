import fs from "node:fs";
import pg from "pg";

// Knowledge gaps from reviews of closed conversations: the prompts and parsers, the sweep, merging, re-reviews and the worklist.
// The model answers from a stubbed endpoint, and GAPTEST data, TestCo's model config and gap settings are removed at the end.

process.env.MODEL_KEY_SECRET = process.env.MODEL_KEY_SECRET || "test-model-key-secret-🔑";

const gr = await import("../src/gap-review.js");
const { getGapSettings, putGapSettings, runGapReviewSweep, listKnowledgeGaps, updateKnowledgeGap } = await import("../src/gaps.js");
const { getModelConfig, putModelConfig } = await import("../src/modelconfig.js");
const { ingestInbound } = await import("../src/ingest.js");
const { listTraces } = await import("../src/trace.js");
const { suggestForQuery } = await import("../src/copilot.js");

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const ENDPOINT = "https://llm.gaptest.invalid/v1";
const RUN = Date.now().toString(36);

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${got !== undefined ? ` — got: ${JSON.stringify(got)}` : ""}`); }
}

// The stub answers by the markers in the conversation: Q:<topic> names the question, KIND:<kind> its review kind.
const QUESTION = (topic: string) => `How do I ${topic} in GAPTEST ${RUN}?`;
const PAGE = "https://docs.gaptest.example/routing";

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME, user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  superPool.on("error", () => {});
  if ((await getModelConfig(A)).provider !== "managed") throw new Error("TestCo has a hosted model, which this test would overwrite");

  const calls: Array<{ step: string; user: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).startsWith(ENDPOINT)) return realFetch(url, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as { system?: string; messages?: Array<{ content: unknown }> };
    const system = body.system ?? "";
    const user = String(body.messages?.[0]?.content ?? "");
    let text = "OK";
    if (system.includes("List the questions in the conversation")) {
      calls.push({ step: "questions", user });
      if (user.includes("FAIL")) return new Response("{}", { status: 500 });
      if (user.includes("BADREQ")) return new Response("{}", { status: 400 });
      if (user.includes("GARBLED")) text = "I could not tell.";
      else {
        const topics = [...user.matchAll(/Q:(\w+)/g)].map((m) => m[1]);
        text = JSON.stringify({ conversation: topics.length ? "questions" : "account_issue", questions: topics.map((t) => ({ question: QUESTION(t), search: t })) });
      }
    } else if (system.includes("For each question you get the conversation")) {
      calls.push({ step: "review", user });
      const kinds = Object.fromEntries([...user.matchAll(/Q:(\w+) KIND:(\w+)/g)].map((m) => [m[1], m[2]]));
      const asked = [...user.matchAll(/<question \d+>\n(.+)\n/g)].map((m) => m[1]);
      text = JSON.stringify({
        reviews: asked.map((q) => {
          const topic = Object.keys(kinds).find((t) => q === QUESTION(t)) ?? "";
          const kind = kinds[topic] ?? "answered";
          return {
            question: q, kind, answer: `The team explained ${topic}.`, page: kind.startsWith("docs") ? (topic === "badpage" ? "javascript:alert(1)" : PAGE) : null, article: "not-an-id",
            suggestion: kind === "answered" ? null : `Explain ${topic}.`, title: kind === "support_knowledge" ? `About ${topic}` : null,
            collection: kind === "support_knowledge" ? "Accounts" : null,
          };
        }),
      });
    } else if (system.includes("You keep the list of knowledge gaps")) {
      calls.push({ step: "match", user });
      const asked = user.match(/<new question>\n(.+)\n/)?.[1] ?? "";
      const label = [...user.matchAll(/^(g\d+): (.+)$/gm)].find((m) => m[2] === asked)?.[1] ?? null;
      text = asked.includes("matchfail") ? "Both, sort of." : JSON.stringify({ match: label });
    }
    return new Response(JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  // A conversation with one customer message and one reply, closed `minutesAgo` minutes ago.
  const conversation = async (subject: string, customer: string, minutesAgo = 30) => {
    const t = await ingestInbound({ tenantId: A, authorType: "customer", subject: `GAPTEST ${RUN} ${subject}`, body: customer });
    await ingestInbound({ tenantId: A, authorType: "agent", ticketId: t.ticketId, body: "Here is how it works." });
    await superPool.query("UPDATE tickets SET status = 'closed', closed_at = now() - make_interval(mins => $2) WHERE id = $1", [t.ticketId, minutesAgo]);
    return t.ticketId;
  };
  const review = async (id: string) =>
    (await superPool.query("SELECT conversation, questions, error, attempts, failures FROM gap_reviews WHERE ticket_id = $1", [id])).rows[0] as
      { conversation: string | null; questions: Array<{ kind: string }>; error: string | null; attempts: number; failures: number } | undefined;
  const sweep = async () => {
    for (let i = 0; i < 10; i++) {
      const before = calls.length;
      await runGapReviewSweep();
      if (calls.length === before) return;
    }
  };
  const ourGaps = async () => (await listKnowledgeGaps(A, { status: "all" })).gaps.filter((g) => g.question.includes(`GAPTEST ${RUN}`));

  const testStart = new Date();
  // Other closed TestCo conversations count as reviewed for the run, so the sweep reaches only this test's tickets.
  const parked = (await superPool.query(
    `INSERT INTO gap_reviews (tenant_id, ticket_id, conversation)
     SELECT tenant_id, id, 'no_question' FROM tickets t WHERE tenant_id = $1 AND status = 'closed'
        AND NOT EXISTS (SELECT 1 FROM gap_reviews r WHERE r.tenant_id = t.tenant_id AND r.ticket_id = t.id)
     RETURNING ticket_id`, [A],
  )).rows.map((r) => r.ticket_id as string);

  try {
    // ---- Prompts and parsers ----
    const transcript = gr.transcriptOf("widget", "Login", [
      { who: "customer", body: "I can't log in" }, { who: "ai", body: "Try resetting" }, { who: "human", body: "Fixed it" },
      { who: "support", body: "Closing" }, { who: "note", body: "It was the SSO setting" }, { who: "customer", body: "  " },
    ]);
    check("the transcript names who wrote each turn",
      transcript.includes("[Customer] I can't log in") && transcript.includes("[AI agent] Try resetting") && transcript.includes("[Human agent] Fixed it")
      && transcript.includes("[Support] Closing") && transcript.includes("[Internal note] It was the SSO setting"), transcript);
    check("the transcript skips empty turns and starts with the channel and subject", transcript.startsWith("Channel: widget\nSubject: Login") && !transcript.includes("[Customer]   "));
    check("a long transcript is cut", gr.transcriptOf("email", "", [{ who: "customer", body: "x".repeat(40000) }]).length === gr.TRANSCRIPT_MAX);
    const setup = { company: "Acme", product: "Hosting for apps", language: "Czech" };
    check("the prompts name the company, the product and the language",
      [gr.questionsPrompt(setup), gr.reviewPrompt(setup)].every((p) => p.includes("Acme") && p.includes("About the product: Hosting for apps") && p.includes("Czech")));
    check("a prompt without a product has no product line", !gr.questionsPrompt({ ...setup, product: "" }).includes("About the product"));

    const listed = gr.parseQuestions('Sure:\n```json\n{"conversation": "questions", "questions": [{"question": "A?", "search": "a"}, {"question": "B?"}, {"question": " "}]}\n```');
    check("the question list is read from a fenced reply", listed?.conversation === "questions" && listed.questions.length === 2, listed);
    check("a question without a search query searches its own text", listed?.questions[1].search === "B?", listed);
    check("an unknown conversation kind is no list", gr.parseQuestions('{"conversation": "chat", "questions": []}') === null);
    check("at most five questions are kept",
      gr.parseQuestions(JSON.stringify({ conversation: "questions", questions: Array.from({ length: 8 }, (_, i) => ({ question: `Q${i}` })) }))?.questions.length === 5);
    check("prose without JSON is no list", gr.parseQuestions("I could not find any questions.") === null);

    const reviews = gr.parseReviews(JSON.stringify({ reviews: [
      { question: "A?", kind: "docs_missing", answer: "Do X", page: "https://d/x", article: null, suggestion: "Add X", title: null, collection: null },
      { question: "B?", kind: "maybe" },
      { question: "", kind: "answered" },
      { question: "C?", kind: "answered", answer: " " },
    ] }));
    check("a review entry with an unknown kind or no question is dropped", reviews?.length === 2 && reviews[0].kind === "docs_missing" && reviews[1].question === "C?", reviews);
    check("empty texts become null", reviews?.[1].answer === null && reviews?.[1].page === null, reviews);
    check("a reply without reviews is none", gr.parseReviews('{"verdict": "fine"}') === null);

    const ids = new Set(["g1", "g2"]);
    check("a match names an open gap", gr.parseMatch('{"match": "g2"}', ids) === "g2");
    check("no match is null", gr.parseMatch('{"match": null}', ids) === null);
    check("a match that names no open gap makes no sense", gr.parseMatch('{"match": "g9"}', ids) === undefined && gr.parseMatch("same as g1", ids) === undefined);
    check("the match input lists the gaps and the new question",
      gr.matchInput("New?", [{ id: "g1", question: "Old?" }]) === "<gaps>\ng1: Old?\n</gaps>\n\n<new question>\nNew?\n</new question>");

    // ---- Settings ----
    check("the review is off by default", (await getGapSettings(A)).enabled === false);
    const refused = await putGapSettings(A, { enabled: true }).then(() => null, (e: Error) => e.message);
    check("the review cannot be switched on without a hosted model", refused !== null && (await getGapSettings(A)).enabled === false, refused);
    await putModelConfig(A, { provider: "anthropic", endpoint: ENDPOINT, model: "gap-model", apiKey: "k" });
    const fresh = await conversation("before switching on", "Q:routing KIND:docs_missing");
    await runGapReviewSweep();
    check("nothing is reviewed while the review is off", !(await review(fresh)) && calls.length === 0);
    await superPool.query("DELETE FROM tickets WHERE id = $1", [fresh]);
    check("the review switches on", (await putGapSettings(A, { enabled: true })).enabled && (await getGapSettings(A)).enabled);
    await putModelConfig(A, { provider: "managed" });
    const modelless = await conversation("without a model", "Q:routing KIND:docs_missing");
    await runGapReviewSweep();
    check("a workspace without a hosted model is skipped without a claim", !(await review(modelless)) && calls.length === 0);
    await superPool.query("DELETE FROM tickets WHERE id = $1", [modelless]);
    await putModelConfig(A, { provider: "anthropic", endpoint: ENDPOINT, model: "gap-model", apiKey: "k" });

    // ---- The sweep reviews closed conversations and merges repeats ----
    const routing1 = await conversation("routing one", "Q:routing KIND:docs_missing");
    const routing2 = await conversation("routing two", "Q:routing KIND:docs_missing and Q:billing KIND:support_knowledge", 25);
    const answered = await conversation("answered", "Q:cron KIND:answered", 20);
    const account = await conversation("account", "my project is down", 15);
    const recent = await conversation("too recent", "Q:recent KIND:docs_missing", 2);
    const failing = await conversation("failing", "FAIL Q:fail KIND:docs_missing", 12);
    const garbled = await conversation("garbled", "GARBLED Q:garbled KIND:docs_missing", 11);
    const rejected = await conversation("rejected", "BADREQ Q:rejected KIND:docs_missing", 13);
    const atomic = await conversation("atomic", "Q:atomone KIND:docs_missing and Q:matchfail KIND:docs_missing", 16);
    const badPage = await conversation("bad page", "Q:badpage KIND:docs_unclear", 14);
    const outbound = await ingestInbound({ tenantId: A, authorType: "agent", subject: `GAPTEST ${RUN} outbound`, body: "Q:outbound KIND:docs_missing" });
    await superPool.query("UPDATE tickets SET status = 'closed', closed_at = now() - interval '30 minutes' WHERE id = $1", [outbound.ticketId]);
    const open = await ingestInbound({ tenantId: A, authorType: "customer", subject: `GAPTEST ${RUN} open`, body: "Q:open KIND:docs_missing" });
    await sweep();

    const r1 = await review(routing1);
    check("a closed conversation is reviewed", r1?.conversation === "questions" && r1.questions.length === 1 && r1.error === null, r1);
    check("a conversation that closed a moment ago waits", !(await review(recent)));
    // It would come due while the test runs.
    await superPool.query("DELETE FROM tickets WHERE id = $1", [recent]);
    check("an open conversation is not reviewed", !(await review(open.ticketId)));
    const acc = await review(account);
    check("a conversation without questions is reviewed once, with no review call", acc?.conversation === "account_issue" && acc.questions.length === 0
      && !calls.some((c) => c.step === "review" && c.user.includes("my project is down")), acc);
    const ans = await review(answered);
    check("an answered question is counted but files no gap", ans?.questions[0]?.kind === "answered", ans);
    const failed = await review(failing);
    check("a provider failure keeps its error without using up an attempt", failed?.error !== null && failed?.attempts === 0 && failed?.failures === 1 && failed?.conversation === null, failed);
    const garbledReview = await review(garbled);
    check("a reply out of format uses up an attempt", garbledReview?.error === "no question list in the answer" && garbledReview.attempts === 1, garbledReview);
    check("a conversation where no customer wrote is not reviewed", !(await review(outbound.ticketId)));
    const rejectedReview = await review(rejected);
    check("a request that the provider rejects uses up an attempt", rejectedReview?.error?.startsWith("anthropic 400") === true && rejectedReview.attempts === 1, rejectedReview);
    const atomicReview = await review(atomic);
    check("a failed match files none of the conversation's gaps",
      atomicReview?.error === "no match in the answer" && !(await ourGaps()).some((g) => g.question === QUESTION("atomone")), atomicReview);
    check("a page that is no web address is dropped", (await ourGaps()).find((g) => g.question === QUESTION("badpage"))?.pageUrl === null);
    const badTrace = (await superPool.query("SELECT draft, gate_reason FROM draft_traces WHERE ticket_id = $1 AND kind = 'gap_review'", [badPage])).rows[0];
    check("the trace keeps no page that is no web address, and counts one gap", JSON.parse(badTrace?.draft ?? "{}").reviews?.[0]?.page === null && badTrace?.gate_reason === "1 gap", badTrace);
    check("the trace keeps no article id that is no id", JSON.parse(badTrace?.draft ?? "{}").reviews?.[0]?.article === null, badTrace);

    // ---- Retries wait, and stop ----
    // The messages are older than the review, so only the retry rules can make a conversation due again.
    const age = async (id: string, reviewed: string) => {
      await superPool.query("UPDATE messages SET created_at = now() - interval '3 days' WHERE ticket_id = $1", [id]);
      await superPool.query(`UPDATE gap_reviews SET reviewed_at = now() - interval '${reviewed}' WHERE ticket_id = $1`, [id]);
    };
    await superPool.query("UPDATE messages SET body = replace(body, 'FAIL ', '') WHERE ticket_id = $1", [failing]);
    await age(failing, "7 hours");
    await sweep();
    check("a failed review is retried after six hours", (await review(failing))?.conversation === "questions", await review(failing));
    await age(garbled, "7 hours");
    await superPool.query("UPDATE gap_reviews SET attempts = 3 WHERE ticket_id = $1", [garbled]);
    const callsBefore = calls.length;
    await sweep();
    check("a review stops after three attempts", calls.length === callsBefore && (await review(garbled))?.attempts === 3);
    await superPool.query("UPDATE gap_reviews SET attempts = 1, failures = 10 WHERE ticket_id = $1", [garbled]);
    await sweep();
    check("a review stops after ten failures", calls.length === callsBefore);
    await superPool.query("UPDATE gap_reviews SET failures = 9 WHERE ticket_id = $1", [garbled]);
    await sweep();
    check("a review below both limits is retried", calls.length > callsBefore && (await review(garbled))?.attempts === 2, await review(garbled));
    const stale = await conversation("stale", "Q:stale KIND:answered");
    await superPool.query("INSERT INTO gap_reviews (tenant_id, ticket_id, attempts) VALUES ($1, $2, 0)", [A, stale]);
    await age(stale, "2 hours");
    await sweep();
    const staleReview = await review(stale);
    check("a review that was cut off runs again and counts an attempt", staleReview?.conversation === "questions" && staleReview.attempts === 1, staleReview);
    const ancient = await conversation("ancient", "Q:ancient KIND:docs_missing", 200 * 24 * 60);
    await sweep();
    check("a conversation that closed more than 180 days ago is not reviewed", !(await review(ancient)));

    // ---- One sweep takes at most two conversations of a workspace ----
    const batch = [await conversation("batch one", "Q:batch KIND:answered"), await conversation("batch two", "Q:batch KIND:answered"), await conversation("batch three", "Q:batch KIND:answered")];
    await runGapReviewSweep();
    const batchReviewed = (await Promise.all(batch.map(review))).filter((r) => r?.conversation).length;
    check("one sweep reviews at most two conversations of a workspace", batchReviewed === 2, batchReviewed);
    await sweep();
    check("workspaces with the review off are left alone",
      Number((await superPool.query("SELECT count(*) FROM gap_reviews WHERE tenant_id <> $1 AND reviewed_at >= $2", [A, testStart])).rows[0].count) === 0);

    const gaps = await ourGaps();
    const routingGap = gaps.find((g) => g.question === QUESTION("routing"));
    check("a repeated question joins its open gap", routingGap?.occurrences === 2 && routingGap.questions.length === 2, routingGap);
    check("the gap keeps the kind and the page of its first conversation", routingGap?.kind === "docs_missing" && routingGap.pageUrl === PAGE, routingGap);
    check("the gap lists its conversations with their subjects, the newest first",
      routingGap?.questions[0].ticketId === routing2 && routingGap.questions[1]?.subject === `GAPTEST ${RUN} routing one`, routingGap?.questions);
    check("an article id that is no id is dropped", routingGap?.questions.every((q) => q.articleId === null), routingGap?.questions);
    check("each conversation of a gap has its own id", new Set(routingGap?.questions.map((q) => q.id)).size === 2, routingGap?.questions);
    const billing = gaps.find((g) => g.question === QUESTION("billing"));
    check("a support question becomes its own gap with a suggested collection",
      billing?.kind === "support_knowledge" && billing.collection === "Accounts" && billing.questions[0].title === "About billing", billing);
    check("answered questions file no gap", !gaps.some((g) => g.question === QUESTION("cron")));
    check("the match call lists the known gaps", calls.some((c) => c.step === "match" && c.user.includes(`: ${QUESTION("routing")}`)));
    check("the review sees the conversation and the collections", calls.some((c) => c.step === "review" && c.user.includes("[Support] Here is how it works.") && c.user.includes("Collections:")));

    const { summary, openCount } = await listKnowledgeGaps(A);
    check("the summary counts the reviewed conversations and questions",
      summary.conversations.account_issue >= 1 && summary.questions.answered >= 1 && summary.questions.docs_missing >= 2 && openCount >= 2, summary);

    const { traces } = await listTraces(A, { page: 1, pageSize: 200, outcome: "gap_review", q: "GAPTEST", from: null, to: null });
    const trace = traces.find((t) => t.ticketId === routing2);
    check("each review is an AI trace in its own category", trace?.kind === "gap_review" && traces.every((t) => t.kind === "gap_review"), traces.slice(0, 3));
    const stored = (await superPool.query("SELECT draft, gate_outcome, gate_reason, model, tokens_in FROM draft_traces WHERE ticket_id = $1 AND kind = 'gap_review'", [routing2])).rows[0];
    check("the trace holds the review, the conversation kind and the gap count",
      JSON.parse(stored?.draft ?? "{}").reviews?.length === 2 && stored?.gate_outcome === "questions" && stored?.gate_reason === "2 gaps" && stored?.tokens_in >= 6, stored);

    // ---- A conversation that closes again is reviewed again, and its old questions leave their gaps ----
    const before = calls.length;
    await runGapReviewSweep();
    check("a reviewed conversation is not reviewed again", calls.length === before);
    await superPool.query("UPDATE messages SET created_at = now() - interval '2 days' WHERE ticket_id = $1", [answered]);
    await superPool.query("UPDATE gap_reviews SET reviewed_at = now() - interval '1 day' WHERE ticket_id = $1", [answered]);
    await superPool.query("UPDATE tickets SET closed_at = now() - interval '11 minutes' WHERE id = $1", [answered]);
    await runGapReviewSweep();
    check("closing a closed conversation again without a new message is no new review", calls.length === before);
    // The review ran a day ago, and the conversation got a reply and closed again since, now as an answered question.
    const closeAgain = async (id: string) => {
      await superPool.query("UPDATE gap_reviews SET reviewed_at = now() - interval '1 day' WHERE ticket_id = $1", [id]);
      await superPool.query("UPDATE messages SET body = replace(body, 'Q:routing KIND:docs_missing', 'Q:routing KIND:answered') WHERE ticket_id = $1", [id]);
      await ingestInbound({ tenantId: A, authorType: "customer", ticketId: id, body: "Thanks, that helped." });
      await superPool.query("UPDATE tickets SET status = 'closed', closed_at = now() - interval '11 minutes' WHERE id = $1", [id]);
    };
    await closeAgain(routing1);
    await sweep();
    const again = (await ourGaps()).find((g) => g.question === QUESTION("routing"));
    check("a re-review replaces the conversation's questions", again?.occurrences === 1 && again.questions.every((q) => q.ticketId === routing2), again);

    await closeAgain(routing2);
    await sweep();
    const after = await ourGaps();
    check("an open gap that loses its last conversation is deleted", !after.some((g) => g.question === QUESTION("routing")));
    check("a re-review that finds the same question keeps its gap", after.find((g) => g.question === QUESTION("billing"))?.id === billing?.id, after.map((g) => g.question));

    // ---- Triage, and deleting a conversation ----
    const article = "00000000-0000-4000-8000-000000000001";
    const reopened = await updateKnowledgeGap(A, billing!.id, { status: "resolved", resolvedArticleId: article })
      .then(() => updateKnowledgeGap(A, billing!.id, { status: "open" }));
    check("a reopened gap keeps no resolving article", reopened?.status === "open" && reopened.resolvedArticleId === null, reopened);
    const triaged = await updateKnowledgeGap(A, billing!.id, { status: "resolved" });
    check("a gap is resolved", triaged?.status === "resolved" && triaged.questions.length === 1, triaged);
    check("the open list leaves out resolved gaps", !(await listKnowledgeGaps(A)).gaps.some((g) => g.id === billing!.id));
    await conversation("billing again", "Q:billing KIND:support_knowledge", 12);
    await sweep();
    const resolvedAgain = (await ourGaps()).filter((g) => g.question === QUESTION("billing"));
    check("a repeat of a resolved gap joins it and leaves it resolved",
      resolvedAgain.length === 1 && resolvedAgain[0].status === "resolved" && resolvedAgain[0].occurrences === 2, resolvedAgain);
    await superPool.query("DELETE FROM tickets WHERE id = $1", [routing2]);
    check("deleting a conversation deletes its questions and its review",
      (await superPool.query("SELECT 1 FROM knowledge_gap_questions WHERE ticket_id = $1 UNION ALL SELECT 1 FROM gap_reviews WHERE ticket_id = $1", [routing2])).rowCount === 0);
    const billingLeft = (await ourGaps()).find((g) => g.id === billing!.id);
    check("a gap counts only the conversations that are left", billingLeft?.occurrences === 1 && billingLeft.questions.length === 1, billingLeft);

    // ---- An answer without sources records no gap ----
    const gapsBefore = Number((await superPool.query("SELECT count(*) FROM knowledge_gaps WHERE tenant_id = $1", [A])).rows[0].count);
    await putModelConfig(A, { provider: "managed" });
    await suggestForQuery(A, `GAPTEST ${RUN} zorblax flux capacitor nobody documents`, { audience: "public" });
    await new Promise((r) => setTimeout(r, 300));
    const gapsAfter = Number((await superPool.query("SELECT count(*) FROM knowledge_gaps WHERE tenant_id = $1", [A])).rows[0].count);
    check("an answer without sources records no gap", gapsAfter === gapsBefore, { gapsBefore, gapsAfter });

    // ---- The migration runs again on every deploy without touching the new rows ----
    const dir = new URL("../../../packages/db/migrations/", import.meta.url);
    const kept = Number((await superPool.query("SELECT count(*) FROM knowledge_gaps WHERE tenant_id = $1", [A])).rows[0].count);
    await superPool.query(fs.readFileSync(new URL("0046_knowledge_gaps.sql", dir), "utf8"));
    await superPool.query(fs.readFileSync(new URL("0140_gap_reviews.sql", dir), "utf8"));
    check("re-running the migrations keeps the gaps", Number((await superPool.query("SELECT count(*) FROM knowledge_gaps WHERE tenant_id = $1", [A])).rows[0].count) === kept);
  } finally {
    globalThis.fetch = realFetch;
    await putModelConfig(A, { provider: "managed" });
    await superPool.query("DELETE FROM gap_settings WHERE tenant_id = $1", [A]);
    await superPool.query("DELETE FROM gap_reviews WHERE tenant_id = $1 AND ticket_id = ANY($2::uuid[])", [A, parked]);
    await superPool.query(
      "DELETE FROM draft_traces WHERE tenant_id = $1 AND ticket_id IN (SELECT id FROM tickets WHERE tenant_id = $1 AND subject LIKE 'GAPTEST%')", [A],
    );
    await superPool.query("DELETE FROM knowledge_gaps WHERE tenant_id = $1 AND question LIKE '%GAPTEST%'", [A]);
    await superPool.query("DELETE FROM tickets WHERE tenant_id = $1 AND subject LIKE 'GAPTEST%'", [A]);
    await superPool.end();
  }

  if (failures > 0) { console.error(`\nGAP REVIEW: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nGAP REVIEW: all checks passed");
  process.exit(0);
}

main().catch((e) => { console.error("gap review ERROR", e); process.exit(1); });
