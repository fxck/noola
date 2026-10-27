import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Our type scale lives in CUSTOM utilities — text-micro/small/body/reading/title/display,
// generated from the --text-* tokens in index.css. tailwind-merge doesn't know these are
// font-sizes, so by default it misreads e.g. `text-small` as a text-COLOR and silently drops
// it whenever a real color (text-muted-foreground, text-foreground, …) is on the same element
// — the element then falls back to the 16px root default. That's what made "half the app" look
// huge after the text-small→text-small codemod (arbitrary sizes were twMerge-safe; named ones
// aren't). Register the custom sizes in the font-size group so cn() keeps them.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["micro", "small", "body", "reading", "title", "display"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
