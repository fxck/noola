import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { AuthShell } from "@/components/auth-shell";
import { BUILD_ID, BUILD_MODE } from "@/lib/build-info";
import { discoverSso, startSso } from "@/lib/sso";
import { ShieldCheck } from "lucide-react";
import { type InstanceConfig, fetchInstanceConfig } from "@/lib/instance";

// Demo credentials + the build easter-egg are a dev convenience — never render them on a
// built (stage/production) login where they'd read as a leak.
const SHOW_DEMO = import.meta.env.DEV;

export function LoginPage() {
  const { login, loginTotp } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState(SHOW_DEMO ? "ales@acme.test" : "");
  const [password, setPassword] = useState(SHOW_DEMO ? "demo1234" : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 2FA (0092): a non-null challenge switches the card to the authenticator-code step.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [sso, setSso] = useState<{ name: string; connectionId: string } | null>(null);
  const [ssoBusy, setSsoBusy] = useState(false);
  // Self-hosted hardening (P2): hide "Create a workspace" when signups are disabled, and the demo
  // hint when the instance runs without the demo seed.
  const [instance, setInstance] = useState<InstanceConfig>({ signupsEnabled: true, demoMode: true, emailEnabled: true });
  useEffect(() => { void fetchInstanceConfig().then(setInstance); }, []);

  // When the email's domain has an SSO connection, surface a "Sign in with SSO" button.
  useEffect(() => {
    const at = email.indexOf("@");
    if (at < 0 || at === email.length - 1) { setSso(null); return; }
    let live = true;
    const t = setTimeout(() => {
      discoverSso(email)
        .then((d) => { if (live) setSso(d.sso && d.connectionId ? { name: d.name ?? "SSO", connectionId: d.connectionId } : null); })
        .catch(() => { if (live) setSso(null); });
    }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [email]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const pending = await login(email, password);
      if (pending) {
        // Password was right; the account needs its authenticator code to finish.
        setChallenge(pending);
        setBusy(false);
        return;
      }
      await navigate({ to: "/" });
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(status === 401 ? "Wrong email or password." : "Couldn't sign in — please try again.");
      setBusy(false);
    }
  }

  async function onSubmitCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await loginTotp(challenge as string, code);
      await navigate({ to: "/" });
    } catch {
      setError("That code didn't work — check your authenticator app and try again.");
      setBusy(false);
    }
  }

  return (
    <AuthShell
      footer={
        <>
          {instance.signupsEnabled && (
            <p className="mt-4 text-center text-sm text-muted-foreground">
              New to Noola?{" "}
              <Link to="/signup" className="font-medium text-foreground underline-offset-4 hover:underline">
                Create a workspace
              </Link>
            </p>
          )}
          {SHOW_DEMO && instance.demoMode && (
            <>
              <p className="mt-2 text-center text-xs text-muted-foreground">
                Demo · <span className="font-medium text-foreground">ales@acme.test</span> / demo1234
              </p>
              <p
                className="mt-3 text-center font-mono text-micro tabular-nums text-muted-foreground/75"
                title="made with too much telemetry"
              >
                build {BUILD_ID} · {BUILD_MODE} · made with too much telemetry
              </p>
            </>
          )}
        </>
      }
    >
      <Card>
          <CardHeader>
            <CardTitle className="text-xl">{challenge ? "Enter your code" : "Sign in"}</CardTitle>
            <CardDescription>
              {challenge ? "Two-factor authentication is on for this account." : "Your team's shared support inbox."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {challenge ? (
              <form onSubmit={onSubmitCode} className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="totp">Authenticator code</Label>
                  <Input
                    id="totp"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123456"
                    autoFocus
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    required
                  />
                </div>
                {error && (
                  <p className="text-sm text-destructive" role="alert">
                    {error}
                  </p>
                )}
                <Button type="submit" variant="brand" disabled={busy || code.length < 6} className="mt-1">
                  {busy && <Spinner className="size-4 text-primary-foreground" />}
                  Verify
                </Button>
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  onClick={() => { setChallenge(null); setCode(""); setError(null); }}
                >
                  Back to password
                </button>
              </form>
            ) : (
            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  <Link
                    to="/forgot-password"
                    className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  >
                    Forgot password?
                  </Link>
                </div>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <Button type="submit" variant="brand" disabled={busy} className="mt-1">
                {busy && <Spinner className="size-4 text-primary-foreground" />}
                Sign in
              </Button>
            </form>
            )}

            {!challenge && sso && (
              <>
                <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={ssoBusy}
                  onClick={() => { setSsoBusy(true); startSso(sso.connectionId); }}
                >
                  {ssoBusy ? <Spinner className="size-4" /> : <ShieldCheck className="size-4" />}
                  Sign in with {sso.name}
                </Button>
              </>
            )}
          </CardContent>
        </Card>
    </AuthShell>
  );
}
