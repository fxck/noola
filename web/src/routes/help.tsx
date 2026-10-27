import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, getRouteApi, useNavigate } from "@tanstack/react-router";
import { Search, BookOpen, Loader2, ChevronRight, ArrowLeft, Sparkles, LifeBuoy, Check } from "lucide-react";
import {
  type PublicArticle,
  type PublicCollection,
  fetchHelpIndex,
  fetchHelpArticle,
  searchHelp,
  deflect,
  escalateToTicket,
} from "@/lib/help";
import { relativeTime } from "@/lib/tickets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { ArticleBody } from "@/components/editor/article-body";

// The public, unauthenticated help center. A workspace exposes the published+public subset of its KB
// here, plus AI-assisted support-form deflection. Scoped by a widget key (?key=…) — the same key the
// Ask-AI widget uses — falling back to the demo workspace so /help works out of the box.
const DEMO_KEY = "wk_demo_acme";

const indexRoute = getRouteApi("/help");
const articleRoute = getRouteApi("/help/$slug");

function useHelpKey(fromSearch: { key?: string } | undefined): string {
  return (fromSearch?.key && fromSearch.key.trim()) || DEMO_KEY;
}

// ── shared chrome ────────────────────────────────────────────────────────────
function HelpShell({ children, keyParam }: { children: ReactNode; keyParam: string }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4">
          <Link to="/help" search={keyParam === DEMO_KEY ? {} : { key: keyParam }} className="flex items-center gap-2 font-semibold tracking-tight">
            <LifeBuoy className="size-5 text-primary" /> Help Center
          </Link>
          <Link to="/login" className="text-sm text-muted-foreground hover:text-foreground">Agent sign in</Link>
        </div>
      </header>
      {children}
      <footer className="mx-auto max-w-3xl px-5 py-10 text-xs text-muted-foreground">
        Powered by Noola · <Link to="/help" className="hover:text-foreground">Help Center</Link>
      </footer>
    </div>
  );
}

// ── index: search + collections + articles ───────────────────────────────────
export function HelpCenterPage() {
  const search = indexRoute.useSearch() as { key?: string; collection?: string };
  const keyParam = useHelpKey(search);
  const navigate = useNavigate();

  const [index, setIndex] = useState<{ articles: PublicArticle[]; collections: PublicCollection[] } | null>(null);
  const [error, setError] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PublicArticle[] | null>(null);
  const [searching, setSearching] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeCollection = search.collection;

  useEffect(() => {
    setIndex(null);
    setError(false);
    fetchHelpIndex(keyParam, activeCollection).then(setIndex).catch(() => setError(true));
  }, [keyParam, activeCollection]);

  useEffect(() => {
    const term = q.trim();
    if (debounce.current) clearTimeout(debounce.current);
    if (term.length < 2) { setResults(null); setSearching(false); return; }
    setSearching(true);
    debounce.current = setTimeout(() => {
      searchHelp(keyParam, term)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 220);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [q, keyParam]);

  const searchMode = q.trim().length >= 2;
  const linkSearch = (extra: Record<string, string>) => (keyParam === DEMO_KEY ? extra : { key: keyParam, ...extra });

  return (
    <HelpShell keyParam={keyParam}>
      {/* hero + search */}
      <section className="relative overflow-hidden border-b bg-muted/30">
        {/* branded noola-signal backdrop: a lit amber core radiating graphite-amber rings */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 grid -translate-x-1/2 -translate-y-1/2 place-items-center"
        >
          <div className="col-start-1 row-start-1 size-[34rem] rounded-full border border-primary/[0.08]" />
          <div className="col-start-1 row-start-1 size-[23rem] rounded-full border border-primary/[0.12]" />
          <div className="col-start-1 row-start-1 size-[13rem] rounded-full border border-primary/[0.16]" />
          <div className="noola-breathe col-start-1 row-start-1 size-16 rounded-full bg-primary/15 motion-reduce:hidden" />
          <div className="col-start-1 row-start-1 size-2 rounded-full bg-primary/70" />
        </div>
        <div className="relative mx-auto max-w-3xl px-5 py-12 text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-balance">How can we help?</h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">Search our guides, or ask a question and we'll try to answer it before you file a ticket.</p>
          <div className="relative mx-auto mt-6 max-w-lg">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search for answers…"
              className="h-12 pl-11 text-base shadow-sm"
              autoFocus
            />
            {searching && <Loader2 className="absolute right-3.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground motion-reduce:animate-none" />}
          </div>
        </div>
      </section>

      <main className="mx-auto max-w-3xl px-5 py-8">
        {searchMode ? (
          <SearchResults results={results} keyParam={keyParam} query={q.trim()} />
        ) : error ? (
          <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">This help center isn't available right now.</p>
        ) : !index ? (
          <div className="grid place-items-center py-16"><Spinner /></div>
        ) : (
          <>
            {activeCollection && (
              <button onClick={() => void navigate({ to: "/help", search: linkSearch({}) })} className="mb-4 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                <ArrowLeft className="size-4" /> All topics
              </button>
            )}

            {!activeCollection && index.collections.length > 0 && (
              <div className="mb-8 grid gap-3 sm:grid-cols-2">
                {index.collections.map((c) => (
                  <Link
                    key={c.id}
                    to="/help"
                    search={linkSearch({ collection: c.id })}
                    className="group flex items-start gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-muted/40"
                  >
                    <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg" style={{ background: (c.color || "#e8930c") + "22", color: c.color || "var(--primary)" }}>
                      <BookOpen className="size-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1 font-medium">{c.name} <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" /></span>
                      {c.description && <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{c.description}</span>}
                      <span className="mt-1 block text-micro text-muted-foreground">{c.count} {c.count === 1 ? "article" : "articles"}</span>
                    </span>
                  </Link>
                ))}
              </div>
            )}

            <ArticleList articles={index.articles} keyParam={keyParam} heading={activeCollection ? undefined : (index.collections.length ? "All articles" : undefined)} />
            {index.articles.length === 0 && (
              <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No published articles yet.</p>
            )}
          </>
        )}
      </main>
    </HelpShell>
  );
}

function SearchResults({ results, keyParam, query }: { results: PublicArticle[] | null; keyParam: string; query: string }) {
  if (results === null) return <div className="grid place-items-center py-12"><Spinner /></div>;
  if (results.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center">
        <p className="text-sm text-muted-foreground">No articles match “{query}”.</p>
        <p className="mt-3 text-sm">Still stuck? <Link to="/help/$slug" params={{ slug: "__contact__" }} search={keyParam === DEMO_KEY ? {} : { key: keyParam }} className="font-medium text-primary hover:underline">Ask us directly →</Link></p>
      </div>
    );
  }
  return <ArticleList articles={results} keyParam={keyParam} heading={`${results.length} ${results.length === 1 ? "result" : "results"}`} />;
}

function ArticleList({ articles, keyParam, heading }: { articles: PublicArticle[]; keyParam: string; heading?: string }) {
  if (articles.length === 0) return null;
  return (
    <div>
      {heading && <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{heading}</h2>}
      <ul className="divide-y overflow-hidden rounded-xl border">
        {articles.map((a) => (
          <li key={a.slug}>
            <Link
              to="/help/$slug"
              params={{ slug: a.slug }}
              search={keyParam === DEMO_KEY ? {} : { key: keyParam }}
              className="group flex items-center gap-3 px-4 py-3 hover:bg-muted/50"
            >
              <BookOpen className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{a.title}</span>
                {a.collection_name && <span className="text-xs text-muted-foreground">{a.collection_name}</span>}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── article page (+ "__contact__" sentinel → deflection form) ────────────────
// Branch-only shell: no hooks below this level's early split, so the `__contact__`
// sentinel and a real slug each mount a component with its own stable hook set
// (fixes the "Rendered fewer hooks than expected" crash on slug→contact nav).
export function HelpArticlePage() {
  const { slug } = articleRoute.useParams();
  const search = articleRoute.useSearch() as { key?: string };
  const keyParam = useHelpKey(search);

  return (
    <HelpShell keyParam={keyParam}>
      {slug === "__contact__" ? <ContactForm keyParam={keyParam} /> : <ArticleView slug={slug} keyParam={keyParam} />}
    </HelpShell>
  );
}

function ArticleView({ slug, keyParam }: { slug: string; keyParam: string }) {
  const [article, setArticle] = useState<PublicArticle | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing">("loading");

  useEffect(() => {
    setState("loading");
    fetchHelpArticle(keyParam, slug).then((a) => { setArticle(a); setState("ok"); }).catch(() => setState("missing"));
  }, [keyParam, slug]);

  const backSearch = keyParam === DEMO_KEY ? {} : { key: keyParam };

  return (
    <main className="mx-auto max-w-3xl px-5 py-8">
        <Link to="/help" search={backSearch} className="mb-5 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Help Center
        </Link>
        {state === "loading" ? (
          <div className="grid place-items-center py-16"><Spinner /></div>
        ) : state === "missing" || !article ? (
          <div className="rounded-xl border border-dashed p-10 text-center">
            <p className="text-sm text-muted-foreground">This article isn't available.</p>
            <Link to="/help" search={backSearch} className="mt-3 inline-block text-sm font-medium text-primary hover:underline">Back to the Help Center</Link>
          </div>
        ) : (
          <article>
            {article.collection_name && <p className="text-xs font-medium uppercase tracking-wide text-primary">{article.collection_name}</p>}
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-balance">{article.title}</h1>
            <p className="mt-2 text-xs text-muted-foreground">Updated {relativeTime(article.published_at || article.updated_at)}</p>
            {article.body?.trim() ? (
              <ArticleBody markdown={article.body} className="mt-6" />
            ) : null}
            <div className="mt-10 rounded-xl border bg-muted/30 p-5 text-center">
              <p className="text-sm font-medium">Didn't find what you needed?</p>
              <Link to="/help/$slug" params={{ slug: "__contact__" }} search={backSearch}>
                <Button className="mt-3 gap-1.5" size="sm"><LifeBuoy className="size-4" /> Contact support</Button>
              </Link>
            </div>
          </article>
        )}
    </main>
  );
}

// ── support-form deflection ──────────────────────────────────────────────────
function ContactForm({ keyParam }: { keyParam: string }) {
  const [question, setQuestion] = useState("");
  const [defl, setDefl] = useState<{ articles: PublicArticle[]; answer: { text: string; confidence: number | null } | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const convId = useRef(`help-${Math.random().toString(36).slice(2)}`);

  const runDeflect = useCallback(() => {
    const q = question.trim();
    if (q.length < 5) { setDefl(null); return; }
    setChecking(true);
    deflect(keyParam, q).then(setDefl).catch(() => setDefl(null)).finally(() => setChecking(false));
  }, [question, keyParam]);

  // Deflect as they pause typing — show self-serve answers before they file.
  useEffect(() => {
    const h = setTimeout(runDeflect, 500);
    return () => clearTimeout(h);
  }, [runDeflect]);

  async function submit() {
    const q = question.trim();
    if (q.length < 5) return;
    setSubmitting(true);
    const id = await escalateToTicket(keyParam, q, convId.current);
    setSubmitting(false);
    if (id) setSubmitted(true);
  }

  const linkSearch = keyParam === DEMO_KEY ? {} : { key: keyParam };

  if (submitted) {
    return (
      <main className="mx-auto max-w-3xl px-5 py-16 text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-full bg-success/10 text-success"><Check className="size-6" /></div>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">We've got your message</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">A support agent will follow up shortly. You can close this page.</p>
        <Link to="/help" search={linkSearch}><Button variant="outline" size="sm" className="mt-6">Back to the Help Center</Button></Link>
      </main>
    );
  }

  const hasSuggestions = defl && (defl.articles.length > 0 || (defl.answer && defl.answer.text));

  return (
    <main className="mx-auto max-w-2xl px-5 py-8">
      <Link to="/help" search={linkSearch} className="mb-5 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Help Center
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">Contact support</h1>
      <p className="mt-1 text-sm text-muted-foreground">Describe your issue. We'll suggest answers as you type — if none fit, send it to our team.</p>

      <Textarea
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        rows={5}
        placeholder="What do you need help with?"
        className="mt-4 resize-y rounded-lg px-3.5 py-3 text-sm leading-relaxed"
        autoFocus
      />

      {checking && <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> Looking for answers…</p>}

      {hasSuggestions && (
        <div className="mt-4 rounded-xl border bg-muted/30 p-4">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary"><Sparkles className="size-3.5" /> This might help</p>
          {defl!.answer && defl!.answer.text && (
            <p className="mt-2.5 whitespace-pre-wrap border-l-2 border-primary/40 pl-3 text-sm text-foreground/90">{defl!.answer.text}</p>
          )}
          {defl!.articles.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {defl!.articles.slice(0, 4).map((a) => (
                <li key={a.slug}>
                  <Link to="/help/$slug" params={{ slug: a.slug }} search={linkSearch} className="flex items-center gap-2 text-sm text-primary hover:underline">
                    <BookOpen className="size-3.5 shrink-0" /> {a.title}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-5 flex items-center gap-3">
        <Button onClick={() => void submit()} disabled={submitting || question.trim().length < 5} className="gap-1.5">
          {submitting ? <><Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> Sending…</> : <>Send to support</>}
        </Button>
        {hasSuggestions && <span className="text-xs text-muted-foreground">Found your answer above? No need to send.</span>}
      </div>
    </main>
  );
}
