import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { type DraftPrompt, HANDOFF_RULES_MAX, type Persona, TONES, fetchPersona, savePersona } from "@/lib/persona";
import { SettingsPage } from "@/components/settings-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";

// Agent persona settings — the tenant's voice for AI drafts & autoreplies. A small, text-only
// surface: it steers the model's prompt, it doesn't add tools or change retrieval.

// The form holds the handoff rules as the text the field shows, so the default reads as text too.
type PersonaForm = Omit<Persona, "handoffRules"> & { handoffRules: string };

const EMPTY: PersonaForm = { tone: "friendly", signature: "", guardrails: "", instructions: "", handoffRules: "" };

export function SettingsPersonaPage() {
  const [form, setForm] = useState<PersonaForm | null>(null);
  const [saved, setSaved] = useState<PersonaForm>(EMPTY);
  const [defaultRules, setDefaultRules] = useState("");
  const [prompt, setPrompt] = useState<DraftPrompt | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);

  const toForm = (p: Persona, defaults: string): PersonaForm => ({ ...p, handoffRules: p.handoffRules ?? defaults });

  function load() {
    setStatus("loading");
    fetchPersona()
      .then((r) => {
        const f = toForm(r.persona, r.defaultHandoffRules);
        setForm(f); setSaved(f); setDefaultRules(r.defaultHandoffRules); setPrompt(r.prompt); setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }
  useEffect(load, []);

  const dirty = form != null && JSON.stringify(form) !== JSON.stringify(saved);
  const set = <K extends keyof PersonaForm>(k: K, v: PersonaForm[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      const rules = form.handoffRules.trim();
      const p = await savePersona({ ...form, handoffRules: rules === defaultRules ? null : rules });
      const f = toForm(p, defaultRules);
      setForm(f); setSaved(f);
      toast.success("Persona saved — it applies to new AI drafts.");
      fetchPersona().then((r) => setPrompt(r.prompt)).catch(() => {});
    } catch {
      toast.error("Couldn't save the persona.");
    } finally { setSaving(false); }
  }

  return (
    <SettingsPage
      active="persona"
      title="Agent persona"
      description="The voice your AI uses in drafts and autoreplies — it steers tone and sign-off, not grounding."
      status={status}
      onRetry={load}
      errorTitle="Couldn't load the persona settings"
      actions={
        form && (
          <>
            {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
            <Button size="sm" className="gap-1.5" onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Sparkles className="size-3.5" />}
              Save persona
            </Button>
          </>
        )
      }
    >
      {form && (
        <div className="max-w-2xl px-6 pb-10 pt-4">
          <div className="space-y-5 rounded-xl border bg-card p-5">
            <div>
              <Label>Tone</Label>
              <div className="mt-2 flex flex-wrap gap-2">
                {TONES.map((t) => (
                  <button
                    key={t}
                    onClick={() => set("tone", t)}
                    className={`rounded-full border px-3 py-1.5 text-sm capitalize transition-colors ${
                      form.tone === t ? "border-primary bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <Field label="Custom instructions">
              {(id) => (
                <Textarea
                  id={id} rows={3}
                  placeholder="e.g. Always offer a next step. Use the customer's first name. Keep replies under 4 sentences."
                  value={form.instructions} onChange={(e) => set("instructions", e.target.value)}
                />
              )}
            </Field>

            <Field label="Guardrails" hint="Hard limits the assistant must never cross.">
              {(id) => (
                <Textarea
                  id={id} rows={2}
                  placeholder="Things the assistant must never do — e.g. promise refunds, quote prices, share internal timelines."
                  value={form.guardrails} onChange={(e) => set("guardrails", e.target.value)}
                />
              )}
            </Field>

            <Field label="Signature" hint="Appended to AI drafts and autoreplies.">
              {(id) => (
                <Input
                  id={id}
                  placeholder="— The Acme Support Team"
                  value={form.signature} onChange={(e) => set("signature", e.target.value)}
                />
              )}
            </Field>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="persona-handoff">When to help and when to hand off</Label>
                {form.handoffRules.trim() !== defaultRules && (
                  <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2" disabled={saving} onClick={() => set("handoffRules", defaultRules)}>
                    <RotateCcw className="size-3.5" />
                    Reset to default
                  </Button>
                )}
              </div>
              <Textarea
                id="persona-handoff"
                autoGrow
                rows={5}
                maxLength={HANDOFF_RULES_MAX}
                value={form.handoffRules}
                onChange={(e) => set("handoffRules", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Used when the AI answers customers on its own, in autoreplies and the widget. Leave it empty to use the default.
              </p>
            </div>

            <div className="border-t pt-4">
              <button
                type="button"
                onClick={() => setPromptOpen((o) => !o)}
                aria-expanded={promptOpen}
                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronRight className={cn("size-3.5 transition-transform duration-150", promptOpen && "rotate-90")} />
                Show the full prompt
              </button>
              {promptOpen && prompt && (
                <div className="mt-3 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    What the AI is told before each answer, in this order. Only the persona and the handoff rules can be changed.
                  </p>
                  <PromptPart title="Your persona, as saved" text={prompt.persona || "Nothing yet. The default persona adds nothing."} />
                  <PromptPart title="Your handoff rules" note="When the AI answers on its own" text={form.handoffRules.trim() || defaultRules} />
                  <PromptPart title="Always" text={prompt.always} />
                  <PromptPart title="Answer forms" note="When the AI answers on its own" text={prompt.answerForms} />
                  <PromptPart title="No sources" note="When the AI answers on its own and the docs search found nothing" text={prompt.noSources} />
                  <PromptPart title="Sources" text="The passages the docs search found, numbered, each with its title and link." muted />
                  <p className="text-xs text-muted-foreground">The conversation so far and the customer's latest message follow as the question.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </SettingsPage>
  );
}

function PromptPart({ title, note, text, muted }: { title: string; note?: string; text: ReactNode; muted?: boolean }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-foreground">
        {title}
        {note && <span className="font-normal text-muted-foreground"> · {note}</span>}
      </p>
      <pre className={cn("whitespace-pre-wrap rounded-md border bg-muted/40 p-3 font-mono text-xs", muted ? "italic text-muted-foreground" : "text-foreground")}>
        {text}
      </pre>
    </div>
  );
}
