#!/usr/bin/env node
// Craft guard — a dependency-free regression check for the design-system foundations laid in the
// 2026-07 UX overhaul (tokenized type scale + palette). Fails (exit 1) if a banned, *tokenizable*
// arbitrary Tailwind value creeps back into src/. This is deliberately narrow: it only bans values
// that HAVE a token replacement, so it stays at zero violations and never fights legitimate cases.
//
// Run: `node tools/craft-guard.mjs`  (wire into CI or a pre-push hook).
//
// NOT banned (no token exists / intentional): sub-11px avatar & badge initials `text-[8px]`/
// `text-[9px]` scaled to tiny circles, relative `text-[0.9em]`, and brand hex (Discord `#5865F2`).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

// Each rule: a matcher + why + the fix. Kept at zero current violations by design.
const RULES = [
  {
    id: "arbitrary-font-size",
    // text-[Npx] where N ≥ 10 — every such size maps to a type token (text-micro=11, small=13,
    // body=14, reading=15, title=14). Single-digit 8/9px avatar-initials have no token → allowed.
    re: /\btext-\[(?:[1-9][0-9]+)px\]/g,
    why: "arbitrary font size — use a type token (text-micro/small/body/reading/title)",
  },
  {
    id: "transition-all",
    // `transition-all` animates every property incl. layout → jank; name the properties.
    re: /\btransition-all\b/g,
    why: "transition-all animates layout too — specify properties (transition-[transform,opacity])",
  },
];

/** Recursively collect .ts/.tsx files under a dir. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

let violations = 0;
for (const file of walk(SRC)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        violations++;
        console.error(`${relative(SRC, file)}:${i + 1}  [${rule.id}] "${m[0]}" — ${rule.why}`);
      }
    }
  });
}

if (violations > 0) {
  console.error(`\n✗ craft-guard: ${violations} violation(s). See above.`);
  process.exit(1);
}
console.log("✓ craft-guard: clean (type tokens + transitions honored).");
