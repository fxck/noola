import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
// Self-hosted typefaces (bundled by Vite — no CDN). Mona Sans = the chosen UI/display
// grotesk; JetBrains Mono = the developer-facing mono for IDs, SLA, timestamps, metrics.
import "@fontsource-variable/mona-sans";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";
import { initTheme } from "@/lib/theme";
import { startClsObserver } from "@/lib/cls-observer";
import { AuthProvider, useAuth } from "@/auth/auth";
import { router } from "@/router";
import { Spinner } from "@/components/ui/spinner";
import { RealtimeProvider } from "@/lib/realtime-context";
import { NerdModeProvider } from "@/lib/nerd-mode";
import { QueueProvider } from "@/lib/queue-context";
import { JobsProvider } from "@/lib/jobs-context";
import { Toaster } from "@/components/ui/toaster";

function App() {
  const auth = useAuth();
  // Gate routing on the initial /auth/me hydration so route guards see resolved auth.
  if (auth.loading) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    );
  }
  // One socket + tenant channel for the whole authed session; nerd mode wraps all.
  return (
    <NerdModeProvider>
      <RealtimeProvider>
        <QueueProvider>
          <JobsProvider>
            <RouterProvider router={router} context={{ auth }} />
            <Toaster />
          </JobsProvider>
        </QueueProvider>
      </RealtimeProvider>
    </NerdModeProvider>
  );
}

// Apply the stored/OS theme before first paint so dark mode never flashes light.
initTheme();

// Layout-shift instrumentation (dev, or `localStorage.noola_cls='1'` on any build).
startClsObserver();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
);
