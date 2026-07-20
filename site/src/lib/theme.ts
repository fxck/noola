import { useEffect, useState } from "react";

// Theme is the `.dark` class on <html> (matches the product exactly, so the two share one token set).
// Dark is the hero; the choice persists under the product's own `noola.theme` key.
export type Theme = "dark" | "light";

function current(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() =>
    typeof document === "undefined" ? "dark" : current(),
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem("noola.theme", theme);
    } catch {
      /* private mode — the class still applies for this session */
    }
  }, [theme]);

  return {
    theme,
    toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")),
  };
}
