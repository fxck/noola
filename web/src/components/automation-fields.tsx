import { Link } from "@tanstack/react-router";
import { Combobox } from "@/components/ui/combobox";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  type Action,
  type ActionType,
  type HttpMethod,
  type AssignStrategy,
  type Priority,
  type SurveyKind,
} from "@/lib/automations";

interface Opt {
  value: string;
  label: string;
}

// Swapping an action's type resets it to that type's default shape (so stale fields from the
// previous type don't ride along into the payload).
export function resetAction(type: ActionType): Action {
  switch (type) {
    case "assign":
      return { type, strategy: "specific", assigneeId: null };
    case "set_status":
      return { type, status: "closed" };
    case "set_priority":
      return { type, priority: "normal" };
    case "escalate":
      return { type, priority: "urgent", assigneeId: null };
    case "add_tags":
      return { type, tags: [] };
    case "reply":
      return { type, body: "" };
    case "survey":
      return { type, surveyKind: "both" };
    case "stop":
      return { type };
    case "notify":
      return { type, integrationId: undefined, text: "" };
    case "run":
      return { type, cmd: "" };
    case "http":
      return { type, method: "GET", url: "", headers: "", httpBody: "" };
    case "rag":
      return { type, autoReply: false };
    case "kb_upsert":
      return { type, kbTitle: "", kbBody: "" };
    case "contact_update":
      return { type, contactEmail: "", contactName: "", contactFields: "" };
    case "broadcast_send":
      return { type, broadcastSubject: "", broadcastBody: "" };
    case "set_fields":
      return { type, setFields: "" };
    case "web_fetch":
      return { type, url: "" };
    case "browser_extract":
      return { type, url: "" };
  }
}

// The per-type fields for a single action — shared by the form-editor rows and the canvas
// inspector so the two authoring surfaces never drift. Renders only the type-specific controls;
// the type picker + delete affordance live at each call site (they differ per surface).
export function ActionFields({
  action,
  onChange,
  assigneeOptions,
  integrationOptions,
}: {
  action: Action;
  onChange: (patch: Partial<Action>) => void;
  assigneeOptions: Opt[];
  integrationOptions: Opt[];
}) {
  if (action.type === "assign") {
    const strategy: AssignStrategy = action.strategy ?? "specific";
    return (
      <div className="space-y-2">
        <Combobox
          value={strategy}
          onChange={(v) => onChange({ strategy: v as AssignStrategy })}
          options={[
            { value: "specific", label: "Specific agent" },
            { value: "round_robin", label: "Round-robin (rotate)" },
            { value: "least_loaded", label: "Least loaded" },
          ]}
        />
        {strategy === "specific" ? (
          <Combobox
            value={action.assigneeId ?? ""}
            onChange={(v) => onChange({ assigneeId: v || null })}
            options={assigneeOptions}
          />
        ) : (
          <p className="text-micro text-muted-foreground">
            Rotates across all agents. Configure a specific pool in{" "}
            <Link to="/settings/routing" className="font-medium text-primary underline-offset-4 hover:underline">
              Settings → Routing
            </Link>
            .
          </p>
        )}
      </div>
    );
  }
  if (action.type === "set_status") {
    return (
      <Combobox
        value={action.status ?? "closed"}
        onChange={(v) => onChange({ status: v as "open" | "closed" })}
        options={[
          { value: "closed", label: "Close ticket" },
          { value: "open", label: "Reopen ticket" },
        ]}
      />
    );
  }
  if (action.type === "set_priority") {
    return (
      <Combobox
        value={action.priority ?? "normal"}
        onChange={(v) => onChange({ priority: v as Priority })}
        options={[
          { value: "low", label: "Low" },
          { value: "normal", label: "Normal" },
          { value: "high", label: "High" },
          { value: "urgent", label: "Urgent" },
        ]}
      />
    );
  }
  if (action.type === "add_tags") {
    return (
      <Input
        value={(action.tags ?? []).join(", ")}
        onChange={(e) => onChange({ tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) })}
        placeholder="Tags, comma-separated — e.g. vip, billing"
      />
    );
  }
  if (action.type === "survey") {
    return (
      <div className="space-y-2">
        <Combobox
          value={action.surveyKind ?? "both"}
          onChange={(v) => onChange({ surveyKind: v as SurveyKind })}
          options={[
            { value: "csat", label: "CSAT (1–5 stars)" },
            { value: "nps", label: "NPS (0–10)" },
            { value: "both", label: "Both" },
          ]}
        />
        <p className="text-micro text-muted-foreground">Delivered once per ticket (deduped).</p>
      </div>
    );
  }
  if (action.type === "stop") {
    return (
      <p className="text-micro text-muted-foreground">
        Halts this flow's remaining steps and skips any later rules for the same trigger (first match wins).
      </p>
    );
  }
  if (action.type === "reply") {
    return (
      <Textarea
        autoGrow
        rows={2}
        placeholder="Message to post — use {{subject}} / {{body}} to insert ticket fields"
        value={action.body ?? ""}
        onChange={(e) => onChange({ body: e.target.value })}
      />
    );
  }
  if (action.type === "run") {
    return (
      <Textarea
        autoGrow
        rows={3}
        className="font-mono text-xs"
        placeholder={"Shell command — e.g.\ncurl -s $API_URL/health\nUse {{subject}} / {{steps.*}} to interpolate."}
        value={action.cmd ?? ""}
        onChange={(e) => onChange({ cmd: e.target.value })}
      />
    );
  }
  if (action.type === "http") {
    const method = action.method ?? "GET";
    const hasBody = method !== "GET" && method !== "DELETE";
    return (
      <div className="space-y-2">
        <div className="flex gap-2">
          <div className="w-28 shrink-0">
            <Combobox
              value={method}
              onChange={(v) => onChange({ method: v as HttpMethod })}
              options={["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m }))}
            />
          </div>
          <Input
            className="min-w-0 flex-1 font-mono text-xs"
            placeholder="https://api.example.com/{{contact.id}}"
            value={action.url ?? ""}
            onChange={(e) => onChange({ url: e.target.value })}
          />
        </div>
        <Textarea
          autoGrow
          rows={2}
          className="font-mono text-xs"
          placeholder={"Headers — one per line\nAuthorization: Bearer {{secrets.token}}\nContent-Type: application/json"}
          value={action.headers ?? ""}
          onChange={(e) => onChange({ headers: e.target.value })}
        />
        {hasBody && (
          <Textarea
            autoGrow
            rows={3}
            className="font-mono text-xs"
            placeholder={'Request body — supports {{subject}} / {{body}}\n{ "ticket": "{{ticketId}}" }'}
            value={action.httpBody ?? ""}
            onChange={(e) => onChange({ httpBody: e.target.value })}
          />
        )}
        <p className="text-micro text-muted-foreground">
          The response is available to later steps as <code className="rounded bg-muted px-1">{"{{http.status}}"}</code> and{" "}
          <code className="rounded bg-muted px-1">{"{{http.json.*}}"}</code>.
        </p>
      </div>
    );
  }
  if (action.type === "rag") {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Drafts a grounded answer from your knowledge base for the current ticket. Available to later steps as{" "}
          <code className="rounded bg-muted px-1">{"{{rag.answer}}"}</code>.
        </p>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            className="size-3.5"
            checked={!!action.autoReply}
            onCheckedChange={(v) => onChange({ autoReply: v })}
          />
          Post the answer as a reply automatically
        </label>
      </div>
    );
  }
  if (action.type === "kb_upsert") {
    return (
      <div className="space-y-2">
        <Input
          placeholder="Article title — supports {{subject}}"
          value={action.kbTitle ?? ""}
          onChange={(e) => onChange({ kbTitle: e.target.value })}
        />
        <Textarea
          autoGrow
          rows={4}
          placeholder="Article body — the content indexed into your KB. Supports {{body}} / {{http.json.*}} / {{rag.answer}}."
          value={action.kbBody ?? ""}
          onChange={(e) => onChange({ kbBody: e.target.value })}
        />
        <p className="text-micro text-muted-foreground">Creates or updates a KB article and indexes it for the AI to answer from.</p>
      </div>
    );
  }
  if (action.type === "contact_update") {
    return (
      <div className="space-y-2">
        <Input
          placeholder="Contact email (the key) — e.g. {{contact.email}} or {{webhook.email}}"
          value={action.contactEmail ?? ""}
          onChange={(e) => onChange({ contactEmail: e.target.value })}
        />
        <Input
          placeholder="Name (optional)"
          value={action.contactName ?? ""}
          onChange={(e) => onChange({ contactName: e.target.value })}
        />
        <Textarea
          autoGrow
          rows={3}
          className="font-mono text-xs"
          placeholder={"Fields — one per line\nplan: {{webhook.plan}}\ncompany: {{http.json.org}}"}
          value={action.contactFields ?? ""}
          onChange={(e) => onChange({ contactFields: e.target.value })}
        />
      </div>
    );
  }
  if (action.type === "broadcast_send") {
    return (
      <div className="space-y-2">
        <Input
          placeholder="Subject — supports {{...}}"
          value={action.broadcastSubject ?? ""}
          onChange={(e) => onChange({ broadcastSubject: e.target.value })}
        />
        <Textarea
          autoGrow
          rows={4}
          placeholder="Message body"
          value={action.broadcastBody ?? ""}
          onChange={(e) => onChange({ broadcastBody: e.target.value })}
        />
        <Input
          placeholder="Segment (optional) — leave blank for everyone"
          value={action.broadcastSegment ?? ""}
          onChange={(e) => onChange({ broadcastSegment: e.target.value })}
        />
      </div>
    );
  }
  if (action.type === "set_fields") {
    return (
      <div className="space-y-2">
        <Textarea
          autoGrow
          rows={3}
          className="font-mono text-xs"
          placeholder={"Fields — one per line\nplan: {{contact.plan}}\ngreeting: Hi {{subject}}"}
          value={action.setFields ?? ""}
          onChange={(e) => onChange({ setFields: e.target.value })}
        />
        <p className="text-micro text-muted-foreground">
          Each value is interpolated, then available to later steps as{" "}
          <code className="rounded bg-muted px-1">{"{{vars.key}}"}</code>.
        </p>
      </div>
    );
  }
  if (action.type === "web_fetch") {
    return (
      <div className="space-y-2">
        <Input
          className="font-mono text-xs"
          placeholder="https://docs.example.com/faq — supports {{...}}"
          value={action.url ?? ""}
          onChange={(e) => onChange({ url: e.target.value })}
        />
        <p className="text-micro text-muted-foreground">
          Fetches the page and extracts its readable text into{" "}
          <code className="rounded bg-muted px-1">{"{{web.text}}"}</code> (and{" "}
          <code className="rounded bg-muted px-1">{"{{web.title}}"}</code>) — pair with{" "}
          <span className="font-medium">Save to knowledge base</span> to ingest docs.
        </p>
      </div>
    );
  }
  if (action.type === "browser_extract") {
    return (
      <div className="space-y-2">
        <Input
          className="font-mono text-xs"
          placeholder="https://app.example.com/docs — supports {{...}}"
          value={action.url ?? ""}
          onChange={(e) => onChange({ url: e.target.value })}
        />
        <p className="text-micro text-muted-foreground">
          Renders the page in a headless browser (runs JavaScript) and extracts its text into{" "}
          <code className="rounded bg-muted px-1">{"{{web.text}}"}</code> (and{" "}
          <code className="rounded bg-muted px-1">{"{{web.title}}"}</code>) — use for{" "}
          single-page apps that <span className="font-medium">Fetch a web page</span> returns empty.
        </p>
      </div>
    );
  }
  if (action.type === "escalate") {
    return (
      <div className="space-y-2">
        <Combobox
          value={action.priority ?? "urgent"}
          onChange={(v) => onChange({ priority: v as Priority })}
          options={[
            { value: "high", label: "Priority → High" },
            { value: "urgent", label: "Priority → Urgent" },
          ]}
        />
        <Combobox
          value={action.assigneeId ?? ""}
          onChange={(v) => onChange({ assigneeId: v || null })}
          options={assigneeOptions}
        />
        {integrationOptions.length > 0 && (
          <Combobox
            value={action.integrationId ?? ""}
            onChange={(v) => onChange({ integrationId: v || undefined })}
            options={[{ value: "", label: "No notification" }, ...integrationOptions]}
          />
        )}
        <p className="text-micro text-muted-foreground">Bumps priority; reassigns + notifies a connector if set.</p>
      </div>
    );
  }
  // notify
  return (
    <div className="space-y-2">
      {integrationOptions.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No connectors yet —{" "}
          <Link to="/settings/integrations" className="font-medium text-primary underline-offset-4 hover:underline">
            add one in Integrations
          </Link>
          .
        </p>
      ) : (
        <Combobox
          value={action.integrationId ?? ""}
          onChange={(v) => onChange({ integrationId: v })}
          options={integrationOptions}
        />
      )}
      <Textarea
        autoGrow
        rows={2}
        placeholder="Alert text — supports {{subject}} / {{body}}"
        value={action.text ?? ""}
        onChange={(e) => onChange({ text: e.target.value })}
      />
    </div>
  );
}
