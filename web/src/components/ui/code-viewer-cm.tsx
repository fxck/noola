import { useEffect, useRef, useState } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLineGutter, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import type { CodeViewerProps } from "./code-viewer";

// The CodeMirror 6 half of CodeViewer, loaded lazily (see code-viewer.tsx) so the editor
// and its language modes never weigh on the main bundle. Fully self-contained — no worker
// or CDN. Gives the code/document-viewer experience (syntax highlighting, line numbers,
// wrapping, search) read-only by default, or editable when readOnly=false.

function langExtension(language?: string): Extension[] {
  switch (language) {
    case "markdown": return [markdown()];
    case "html": return [html()];
    case "json": return [json()];
    case "javascript": return [javascript()];
    case "typescript": return [javascript({ typescript: true })];
    default: return [];
  }
}

/** Read the app's active theme (the toggle stamps data-theme; else follow the OS). */
function useIsDark(): boolean {
  const read = (): boolean => {
    if (typeof document === "undefined") return false;
    const a = document.documentElement.dataset.theme;
    if (a === "dark") return true;
    if (a === "light") return false;
    return !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  };
  const [dark, setDark] = useState<boolean>(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onMq = (): void => setDark(read());
    mq?.addEventListener?.("change", onMq);
    return () => {
      obs.disconnect();
      mq?.removeEventListener?.("change", onMq);
    };
  }, []);
  return dark;
}

export default function CodeViewerCM({ value, language, readOnly = true, onChange, height = "100%" }: CodeViewerProps) {
  const parent = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const dark = useIsDark();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // (Re)build the editor when structural config changes (language / theme / read-only).
  useEffect(() => {
    if (!parent.current) return;
    const h = typeof height === "number" ? `${height}px` : height;
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter(),
      history(),
      bracketMatching(),
      indentOnInput(),
      highlightSelectionMatches(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      ...langExtension(language),
      ...(dark ? [oneDark] : []),
      EditorView.theme({
        "&": { height: h, fontSize: "13px", backgroundColor: "transparent" },
        ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", lineHeight: "1.6" },
        ".cm-gutters": { backgroundColor: "transparent", border: "none" },
        "&.cm-focused": { outline: "none" },
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !readOnly) onChangeRef.current?.(u.state.doc.toString());
      }),
    ];
    const view = new EditorView({ state: EditorState.create({ doc: value, extensions }), parent: parent.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // value is intentionally excluded — external value changes are pushed via the effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly, dark, height]);

  // Push external value changes into the existing view without clobbering in-flight edits.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div ref={parent} className="h-full w-full overflow-hidden rounded-lg border bg-card text-left" />;
}
