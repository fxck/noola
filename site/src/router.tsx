import { createRootRoute, createRoute, createRouter, Outlet, ScrollRestoration } from "@tanstack/react-router";
import { Nav } from "./components/nav";
import { Footer } from "./components/footer";
import { Home } from "./app";

// Code-based TanStack Router (no codegen step) — a root layout (nav · outlet · footer) with the
// marketing home beneath it. Kept single-route by design; the shell is ready for /pricing, /docs, …
const rootRoute = createRootRoute({
  component: () => (
    <>
      <ScrollRestoration />
      <Nav />
      <main>
        <Outlet />
      </main>
      <Footer />
    </>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Home,
});

const routeTree = rootRoute.addChildren([indexRoute]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
