// Cumulative Layout Shift instrumentation — turns "the app feels janky / things jump" into a
// measured, attributable list. Each significant unexpected shift logs its score, the largest
// shifting element, and the route; a running CLS total accumulates. This is the measurement
// backbone for the layout-shift reconciliation: fix the worst offenders, watch the number drop.
//
// Off by default. Enabled automatically in dev, by visiting any page with `?cls=1` (persists for
// the session), or by running `localStorage.noola_cls = '1'` in the console. Turn off with
// `delete localStorage.noola_cls` (and drop the query param).

// Minimal typings — the Layout Instability API isn't in lib.dom yet.
interface LayoutShiftSource {
  node?: Node;
  currentRect: DOMRectReadOnly;
  previousRect: DOMRectReadOnly;
}
interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
  sources?: LayoutShiftSource[];
}

function area(r?: DOMRectReadOnly): number {
  return r ? r.width * r.height : 0;
}

function describe(el: Element): string {
  const id = el.id ? `#${el.id}` : "";
  const cls =
    typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
      : "";
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}

export function startClsObserver(): void {
  if (typeof PerformanceObserver === "undefined" || typeof window === "undefined") return;
  // `?cls=1` persists the flag so it survives the SPA's client-side navigations + a manual reload.
  if (new URLSearchParams(window.location.search).has("cls")) localStorage.setItem("noola_cls", "1");
  const enabled = import.meta.env.DEV || localStorage.getItem("noola_cls") === "1";
  if (!enabled) return;

  let total = 0;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as LayoutShiftEntry[]) {
        // The CLS web-vital total excludes input-adjacent shifts. But navigating BY CLICKING makes
        // every page-load reflow input-adjacent — precisely the "clicking through pages" jank — so
        // we log those too (tagged "post-input"), and only fold non-input shifts into the total.
        const recent = entry.hadRecentInput;
        if (!recent) total += entry.value;
        // Low threshold on purpose: this app's jank is death-by-many-small-shifts (a few-px header/
        // padding jump on a tall viewport scores ~0.004), so 0.01 hides exactly what we're hunting.
        if (entry.value < 0.001) continue;
        const src = (entry.sources ?? [])
          .slice()
          .sort((a, b) => area(b.currentRect) - area(a.currentRect))[0];
        const node = src?.node instanceof Element ? src.node : undefined;
        // eslint-disable-next-line no-console
        console.warn(
          `%c[CLS] +${entry.value.toFixed(4)}${recent ? " (post-input)" : ` · total ${total.toFixed(4)}`}%c · ${node ? describe(node) : "(unknown)"} @ ${location.pathname}`,
          "color:#c026d3;font-weight:600",
          "color:inherit",
          node ?? "",
        );
      }
    });
    obs.observe({ type: "layout-shift", buffered: true } as PerformanceObserverInit);
    // eslint-disable-next-line no-console
    console.info(
      "%c[CLS] observer on — navigate around; each jump logs its score + element, with a running total.",
      "color:#c026d3;font-weight:600",
    );
  } catch {
    /* layout-shift entry type unsupported (Firefox/Safari) — skip silently */
  }
}
