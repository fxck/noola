import { useEffect, useState } from "react";
import { setToken } from "@/lib/api";
import { Spinner } from "@/components/ui/spinner";
import { NoolaMark } from "@/components/noola-mark";

// Enterprise SSO landing. The api's /public/sso/complete bridge sends the browser here with the
// freshly-minted session token in the URL fragment (`#token=…` — a fragment, so it never reaches a
// server or proxy log). We store it and hard-navigate to the app root; the AuthProvider's mount
// effect then resolves the token via /auth/me and we're signed in — the same path a password login
// takes, minus the form.
export function SsoCallbackPage() {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
    const token = new URLSearchParams(hash).get("token");
    if (!token) {
      setFailed(true);
      return;
    }
    setToken(token);
    // Hard replace (not a client navigation) so the app remounts and the session bootstraps cleanly
    // from the stored token; also drops the token out of the address bar.
    window.location.replace("/");
  }, []);

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 px-6 text-center">
      <NoolaMark className="size-8" />
      {failed ? (
        <>
          <p className="text-sm text-muted-foreground">
            We couldn't complete single sign-on. Please try again, or sign in with your email and password.
          </p>
          <a href="/login" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
            Back to sign in
          </a>
        </>
      ) : (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" /> Signing you in…
        </div>
      )}
    </div>
  );
}
