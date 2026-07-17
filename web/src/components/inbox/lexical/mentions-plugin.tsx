import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
  type MenuTextMatch,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { $createTextNode, type TextNode } from "lexical";
import { $createMentionNode } from "./mention-node";
import { initials } from "@/lib/tickets";
import { cn } from "@/lib/utils";

export interface MentionCandidate {
  id: string;
  name: string;
  email: string;
}

class MentionOption extends MenuOption {
  constructor(
    public id: string,
    public name: string,
    public email: string,
  ) {
    super(id);
  }
}

/** Keeps the portaled typeahead menu inside the viewport. Lexical anchors the menu at the caret
 *  and only flips it vertically, so a fixed-width menu overflows the right edge near a container /
 *  screen boundary (the "@-menu goes out of bounds" case). Measure after layout and shift
 *  horizontally so both edges stay in view; runs each render so it tracks the caret as you type. */
function ClampedMenu({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = "";
    const r = el.getBoundingClientRect();
    const gutter = 8;
    let dx = 0;
    if (r.right > window.innerWidth - gutter) dx = window.innerWidth - gutter - r.right;
    if (r.left + dx < gutter) dx = gutter - r.left;
    if (dx) el.style.transform = `translateX(${Math.round(dx)}px)`;
  });
  return (
    <div
      ref={ref}
      className="z-50 w-64 max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border bg-popover p-1 shadow-lg"
    >
      {children}
    </div>
  );
}

/** Typeahead over the tenant's members. Triggers on "@" at a word boundary, filters by
 *  name/email, and inserts an atomic MentionNode (which carries the member id). */
export function MentionsPlugin({ members }: { members: MentionCandidate[] }) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);

  // "@" trigger, allowing the empty query so the full member list shows on a bare "@".
  const checkForTrigger = useBasicTypeaheadTriggerMatch("@", { minLength: 0 });
  const triggerFn = useCallback(
    (text: string): MenuTextMatch | null => checkForTrigger(text, editor),
    [checkForTrigger, editor],
  );

  const options = useMemo(() => {
    const q = (query ?? "").toLowerCase();
    return members
      .filter(
        (m) =>
          !q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
      )
      .slice(0, 8)
      .map((m) => new MentionOption(m.id, m.name, m.email));
  }, [members, query]);

  const onSelect = useCallback(
    (option: MentionOption, nodeToReplace: TextNode | null, closeMenu: () => void) => {
      editor.update(() => {
        const mention = $createMentionNode(option.id, option.name);
        if (nodeToReplace) nodeToReplace.replace(mention);
        // Trailing space so the caret lands in normal text after the chip.
        const space = $createTextNode(" ");
        mention.insertAfter(space);
        space.select(1, 1);
        closeMenu();
      });
    },
    [editor],
  );

  return (
    <LexicalTypeaheadMenuPlugin<MentionOption>
      onQueryChange={setQuery}
      onSelectOption={onSelect}
      triggerFn={triggerFn}
      options={options}
      menuRenderFn={(anchorElementRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchorElementRef.current && options.length > 0
          ? createPortal(
              <ClampedMenu>
                {options.map((option, i) => (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-selected={selectedIndex === i}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setHighlightedIndex(i)}
                    onClick={() => selectOptionAndCleanUp(option)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                      selectedIndex === i ? "bg-accent text-accent-foreground" : "text-foreground",
                    )}
                  >
                    <span
                      className="grid size-6 shrink-0 place-items-center rounded-full bg-warning/15 text-micro font-semibold text-warning"
                      aria-hidden
                    >
                      {initials(option.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{option.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{option.email}</span>
                    </span>
                  </button>
                ))}
              </ClampedMenu>,
              anchorElementRef.current,
            )
          : null
      }
    />
  );
}
