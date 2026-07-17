import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/auth/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { AuthShell } from "@/components/auth-shell";
import { fetchInstanceConfig } from "@/lib/instance";

// Self-serve sign-up: creates the account + the team's first workspace in one step, then drops
// straight into the inbox. Public, centered-card surface — same shell as /login.
export function SignupPage() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Self-hosted instances disable workspace signups (P1/P2) — the API 403s, and this page says so
  // instead of rendering a form that can only fail.
  const [signupsEnabled, setSignupsEnabled] = useState(true);
  useEffect(() => { void fetchInstanceConfig().then((c) => setSignupsEnabled(c.signupsEnabled)); }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signup({ email, password, name, orgName });
      await navigate({ to: "/" });
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(
        status === 409
          ? "That email is already registered — try signing in instead."
          : "Couldn't create your workspace — please try again.",
      );
      setBusy(false);
    }
  }

  return (
    <AuthShell
      footer={
        <p className="mt-4 text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
            Sign in
          </Link>
        </p>
      }
    >
      <Card>
          <CardHeader>
            <CardTitle className="text-xl">Create your workspace</CardTitle>
            <CardDescription>
              {signupsEnabled ? "Start your team's shared support inbox." : "Signups are closed on this instance."}
            </CardDescription>
          </CardHeader>
          {!signupsEnabled ? (
            <CardContent>
              <p className="text-sm text-muted-foreground">
                This Noola runs as a private workspace — new workspaces can't be created. Ask an
                administrator to invite you instead.
              </p>
            </CardContent>
          ) : (
          <CardContent>
            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="name">Your name</Label>
                <Input
                  id="name"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
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
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="orgName">Workspace name</Label>
                <Input
                  id="orgName"
                  placeholder="Acme Support"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
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
                Create workspace
              </Button>
            </form>
          </CardContent>
          )}
        </Card>
    </AuthShell>
  );
}
