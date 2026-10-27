import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { type Persona, TONES, fetchPersona, savePersona } from "@/lib/persona";
import { SettingsPage } from "@/components/settings-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";

// Agent persona settings — the tenant's voice for AI drafts & autoreplies. A small, text-only
// surface: it steers the model's prompt, it doesn't add tools or change retrieval.

const EMPTY: Persona = { tone: "friendly", signature: "", guardrails: "", instructions: "" };

export function SettingsPersonaPage() {
  const [form, setForm] = useState<Persona | null>(null);
  const [saved, setSaved] = useState<Persona>(EMPTY);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);

  function load() {
    setStatus("loading");
    fetchPersona()
      .then((p) => { setForm(p); setSaved(p); setStatus("ready"); })
      .catch(() => setStatus("error"));
  }
  useEffect(load, []);

  const dirty = form != null && JSON.stringify(form) !== JSON.stringify(saved);
  const set = <K extends keyof Persona>(k: K, v: Persona[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      const p = await savePersona(form);
      setForm(p); setSaved(p);
      toast.success("Persona saved — it applies to new AI drafts.");
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
          </div>
        </div>
      )}
    </SettingsPage>
  );
}
