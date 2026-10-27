import { appPool, relayPool, withTenant } from "@repo/db";
import { detectLanguage, localeName } from "../src/locale.js";
import {
  getTranslationSettings,
  putTranslationSettings,
  translateText,
  translateOutboundReply,
} from "../src/translate.js";

// Wave 4 — auto-translation seam:
//   • detectLanguage: a labeled eval set the deterministic classifier must get right (script ranges
//     + Latin stopwords), plus the honest-null cases (too short / no signal).
//   • localeName: ISO code → display name (+ graceful fallbacks).
//   • translation_settings: RLS-scoped CRUD (default → upsert → read-back).
//   • model seam: with the rule baseline (no complete()), translateText + translateOutboundReply are
//     no-ops — they NEVER mistranslate and NEVER throw. Run with FORCE_RULE_MODEL=1 for determinism.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}`);
  }
}

interface LangCase { text: string; want: string | null; note: string }
const CASES: LangCase[] = [
  { text: "The payment keeps failing and I need help please", want: "en", note: "english" },
  { text: "Hola, no puedo iniciar sesión en mi cuenta, gracias", want: "es", note: "spanish" },
  { text: "Bonjour, je ne peux pas me connecter à mon compte, merci", want: "fr", note: "french" },
  { text: "Hallo, ich kann mich nicht in mein Konto einloggen, danke", want: "de", note: "german" },
  { text: "Olá, não consigo entrar na minha conta, obrigado", want: "pt", note: "portuguese" },
  { text: "Ciao, non riesco ad accedere al mio account, grazie", want: "it", note: "italian" },
  { text: "Hallo, ik kan niet inloggen op mijn account, bedankt", want: "nl", note: "dutch" },
  { text: "Здравствуйте, я не могу войти в свою учётную запись", want: "ru", note: "russian (cyrillic)" },
  { text: "Доброго дня, я не можу увійти до свого облікового запису", want: "uk", note: "ukrainian (unique letters)" },
  { text: "こんにちは、アカウントにログインできません", want: "ja", note: "japanese (kana)" },
  { text: "안녕하세요, 제 계정에 로그인할 수 없습니다", want: "ko", note: "korean (hangul)" },
  { text: "您好，我无法登录我的帐户", want: "zh", note: "chinese (han)" },
  { text: "مرحبا، لا أستطيع تسجيل الدخول إلى حسابي", want: "ar", note: "arabic" },
  { text: "hi", want: null, note: "too short → null" },
  { text: "?!.", want: null, note: "no letters → null" },
];

async function main() {
  // ---- Part 1: detector eval ----
  console.log(`language detector eval — ${CASES.length} cases`);
  for (const c of CASES) {
    const got = detectLanguage(c.text);
    check(`${c.note} → ${c.want}${got === c.want ? "" : ` (got ${got})`}`, got === c.want);
  }

  // ---- localeName ----
  check("localeName(de) = German", localeName("de") === "German");
  check("localeName(null) = Unknown", localeName(null) === "Unknown");
  check("localeName(xx) falls back to code", localeName("xx") === "XX");

  // ---- Part 2: settings CRUD (RLS) ----
  const superClean = async () =>
    withTenant(A, (c) => c.query("DELETE FROM translation_settings WHERE tenant_id = current_tenant()"));
  await superClean();

  const def = await getTranslationSettings(A);
  check("default settings: en + auto off", def.workspaceLocale === "en" && def.autoTranslate === false);

  const saved = await putTranslationSettings(A, { workspaceLocale: "EN", autoTranslate: true });
  check("upsert normalises locale to lowercase", saved.workspaceLocale === "en");
  check("upsert persists auto_translate on", saved.autoTranslate === true);

  const read = await getTranslationSettings(A);
  check("read-back reflects the upsert", read.autoTranslate === true && read.workspaceLocale === "en");

  const saved2 = await putTranslationSettings(A, { workspaceLocale: "de", autoTranslate: false });
  check("second upsert updates in place (no duplicate row)", saved2.workspaceLocale === "de" && saved2.autoTranslate === false);
  const rows = await withTenant(A, (c) =>
    c.query("SELECT count(*)::int AS n FROM translation_settings WHERE tenant_id = current_tenant()"),
  );
  check("exactly one settings row per tenant", rows.rows[0].n === 1);

  // ---- Part 3: model seam no-op under the rule baseline ----
  check("translateText: same language → null", (await translateText(A, "hello", "en", "en")) === null);
  check("translateText: empty → null", (await translateText(A, "  ", "en", "de")) === null);
  // With FORCE_RULE_MODEL / no hosted model, complete() is absent → honest no-op (not a throw).
  const noop = await translateText(A, "The account is locked", "en", "de");
  check("translateText: no hosted model → null (air-gap-safe no-op)", noop === null);

  // outbound reply with auto-translate off → passthrough, no meta
  await putTranslationSettings(A, { workspaceLocale: "en", autoTranslate: false });
  const t = await withTenant(A, (c) =>
    c.query("INSERT INTO tickets (tenant_id, subject, channel_type, locale) VALUES (current_tenant(), 'TLTEST', 'synthetic', 'de') RETURNING id"),
  );
  const ticketId = t.rows[0].id as string;
  const off = await translateOutboundReply(A, ticketId, "Here is your answer");
  check("outbound: auto-translate off → passthrough + no meta", off.dispatchBody === "Here is your answer" && off.meta === null);

  // auto-translate on, foreign ticket, but rule baseline → still passthrough (translation unavailable)
  await putTranslationSettings(A, { workspaceLocale: "en", autoTranslate: true });
  const on = await translateOutboundReply(A, ticketId, "Here is your answer");
  check("outbound: on but no model → passthrough + no meta (degrade, not break)", on.dispatchBody === "Here is your answer" && on.meta === null);

  await withTenant(A, (c) => c.query("DELETE FROM tickets WHERE id = $1", [ticketId]));
  await superClean();

  await appPool.end();
  await relayPool.end();

  if (failures > 0) {
    console.error(`\nTRANSLATION: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nTRANSLATION: all checks passed");
}

main().catch((e) => {
  console.error("translation seam ERROR", e);
  process.exit(1);
});
