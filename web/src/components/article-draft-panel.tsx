import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Loader2, Sparkles, Check } from "lucide-react";
import { draftArticleFromTicket } from "@/lib/article";
import { createArticle } from "@/lib/kb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/** Turn a resolved conversation into a reusable KB article (the knowledge-loop). Generates a draft
 *  the agent edits, then publishes to the knowledge base. */
export function ArticleDraftPanel({ ticketId }: { ticketId: string }) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [drafted, setDrafted] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);

  async function generate() {
    setLoading(true);
    setError(false);
    try {
      const d = await draftArticleFromTicket(ticketId);
      setTitle(d.title);
      setBody(d.body);
      setDrafted(true);
      setSavedId(null);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!title.trim()) return;
    setSaving(true);
    setError(false);
    try {
      const a = await createArticle(title.trim(), body);
      setSavedId(a.id);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  }

  // Hosted inside the thread overflow popover (it supplies the title row).
  return (
    <section>
      {!drafted ? (
        <>
          <p className="text-xs text-muted-foreground">Turn this resolved case into a reusable help article.</p>
          <Button size="sm" className="mt-2 gap-1.5" onClick={() => void generate()} disabled={loading}>
            {loading ? <><Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> Drafting…</> : <><Sparkles className="size-3.5" /> Draft article</>}
          </Button>
        </>
      ) : savedId ? (
        <div className="mt-2 space-y-2">
          <p className="flex items-center gap-1.5 text-xs text-success"><Check className="size-3.5" /> Published to the knowledge base.</p>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => navigate({ to: "/kb/$articleId", params: { articleId: savedId } })}>
            Open article
          </Button>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Article title" className="h-8 text-sm" />
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            className="resize-y px-2 py-1.5 text-xs leading-relaxed"
            placeholder="Article body (Markdown)"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" className="h-7 gap-1 text-xs" onClick={() => void save()} disabled={saving || !title.trim()}>
              {saving ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Check className="size-3.5" />} Save to KB
            </Button>
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => void generate()} disabled={loading}>
              <Sparkles className="size-3.5" /> Redraft
            </Button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-warning">Something went wrong — please try again.</p>}
    </section>
  );
}
