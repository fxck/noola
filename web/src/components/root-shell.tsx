import { Outlet, useRouterState } from "@tanstack/react-router";
import { AppShell, type NavKey } from "@/components/app-shell";

// The root route renders this ONCE and it stays mounted for the whole session — only the <Outlet/>
// content swaps on navigation. That's the fix for the page-to-page "shuffle": the app frame (nav
// rail + chrome) no longer unmounts and rebuilds on every click. Public routes (login/signup/…)
// render bare, without the frame; authenticated routes render inside a persistent <AppShell> whose
// active nav item + scroll/frame mode are derived from the path, so individual pages stay
// declaration-free (they no longer each wrap themselves in AppShell).

const PUBLIC_PREFIXES = [
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/invite",
  "/join",
  "/sso",
  "/help",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

function shellConfig(pathname: string): {
  active: NavKey;
  scroll?: "page" | "pane";
  frame?: "surface" | "canvas";
} {
  // The inbox conversation surfaces are the only split-pane canvas frames.
  if (pathname === "/" || /^\/tickets\/[^/]+$/.test(pathname)) {
    return { active: "inbox", scroll: "pane", frame: "canvas" };
  }
  const seg = pathname.split("/")[1] ?? "";
  if (seg === "tickets") return { active: "inbox" };
  if (seg === "kb") return { active: "kb" };
  if (seg === "sources" || seg === "documents") return { active: "sources" };
  if (seg === "contacts" || seg === "companies") return { active: "customers" };
  if (seg === "features") return { active: "features" };
  if (seg === "broadcasts") return { active: "broadcasts" };
  if (seg === "analytics") return { active: "analytics" };
  if (seg === "studio") return { active: "studio" };
  if (seg === "settings") return { active: "settings" };
  return { active: "inbox" };
}

export function RootShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (isPublic(pathname)) return <Outlet />;
  const cfg = shellConfig(pathname);
  return (
    <AppShell active={cfg.active} scroll={cfg.scroll} frame={cfg.frame}>
      <Outlet />
    </AppShell>
  );
}
