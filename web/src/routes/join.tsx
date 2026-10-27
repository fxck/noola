import { useEffect, useState, type FormEvent } from "react";
import { Link, getRouteApi, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/auth/auth";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { AuthShell } from "@/components/auth-shell";
import { fetchJoin, joinViaLink, type JoinLanding } from "@/lib/members";

// Public landing for a shareable invite link (/join/$token). Unlike an email invite, the joiner
// supplies their own email here; the link itself may be disabled / expired / exhausted, so we
// look it up first and gate the form behind `valid`.
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function reasonMessage(reason?: string): string {
  switch (reason) {
    case "disabled":
      return "This link has been turned off.";
    case "expired":
      return "This link has expired.";
    case "exhausted":
      return "This link has reached its limit.";
    default:
      return "This link is no longer valid.";
  }
}

export function JoinPage() {
  const { token } = getRouteApi("/join/$token").useParams();
  const { applySession } = useAuth();
  const navigate = useNavigate();

  const [join, setJoin] = useState<JoinLanding | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    (async () => {
      try {
        const data = await fetchJoin(token);
        if (!cancelled) setJoin(data);
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token: tk, user } = await joinViaLink(token, email, password, name || undefined);
      applySession(tk, user);
      await navigate({ to: "/" });
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(
        status === 409
          ? "This account already belongs to another workspace."
          : status === 403
            ? "Your email isn't allowed for this invite link."
            : status === 401
              ? "That email already has an account — enter its existing password."
              : "Couldn't join this workspace — please try again.",
      );
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      {loading ? (
          <Card>
            <CardContent className="grid place-items-center py-16">
              <Spinner className="size-6" />
            </CardContent>
          </Card>
        ) : loadFailed ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-xl">Invite link not found</CardTitle>
              <CardDescription>
                This link is broken or no longer exists. Ask whoever shared it for a new one.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link to="/login" className={cn(buttonVariants({ variant: "outline" }), "w-full")}>
                Back to sign in
              </Link>
            </CardContent>
          </Card>
        ) : join && !join.valid ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-xl">This link can't be used</CardTitle>
              <CardDescription>
                {reasonMessage(join.reason)} Ask an admin for a fresh invite link.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link to="/login" className={cn(buttonVariants({ variant: "outline" }), "w-full")}>
                Back to sign in
              </Link>
            </CardContent>
          </Card>
        ) : join ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-xl">Join {join.orgName}</CardTitle>
              <CardDescription>You've been invited to this workspace.</CardDescription>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>You'll join as</span>
                <Badge variant="outline">{capitalize(join.role)}</Badge>
              </div>
            </CardHeader>
            <CardContent>
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
                  <Label htmlFor="name">Your name</Label>
                  <Input
                    id="name"
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="password">Choose a password</Label>
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
                {error && (
                  <p className="text-sm text-destructive" role="alert">
                    {error}
                  </p>
                )}
                <Button type="submit" variant="brand" disabled={busy} className="mt-1">
                  {busy && <Spinner className="size-4 text-primary-foreground" />}
                  Join workspace
                </Button>
              </form>
            </CardContent>
          </Card>
      ) : null}
    </AuthShell>
  );
}
