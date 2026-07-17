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
import { fetchInvite, acceptInvite, type InviteLanding } from "@/lib/members";

// Public landing for an email invitation (/invite/$id). No session yet — we look up the invite,
// then accept it (which creates or authenticates the invited account server-side and returns a
// session we adopt). Loading / not-found / already-used / accept-error all get their own state.
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function InvitePage() {
  const { id } = getRouteApi("/invite/$id").useParams();
  const { applySession } = useAuth();
  const navigate = useNavigate();

  const [invite, setInvite] = useState<InviteLanding | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

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
        const data = await fetchInvite(id);
        if (!cancelled) setInvite(data);
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token, user } = await acceptInvite(id, password, name || undefined);
      applySession(token, user);
      await navigate({ to: "/" });
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(
        status === 409
          ? "This account already belongs to another workspace."
          : status === 401
            ? "That email already has an account — enter its existing password."
            : "Couldn't accept the invitation — please try again.",
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
              <CardTitle className="text-xl">Invitation not found</CardTitle>
              <CardDescription>
                This invitation link is broken or has been withdrawn. Ask whoever invited you to
                send a fresh one.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link to="/login" className={cn(buttonVariants({ variant: "outline" }), "w-full")}>
                Back to sign in
              </Link>
            </CardContent>
          </Card>
        ) : invite && invite.status !== "pending" ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-xl">This invitation is no longer valid</CardTitle>
              <CardDescription>
                It's already been used or cancelled. Ask an admin at {invite.orgName} to send you a
                new invite.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link to="/login" className={cn(buttonVariants({ variant: "outline" }), "w-full")}>
                Back to sign in
              </Link>
            </CardContent>
          </Card>
        ) : invite ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-xl">
                {invite.inviterName ?? "A teammate"} invited you to join {invite.orgName}
              </CardTitle>
              <CardDescription>
                Joining as{" "}
                <span className="font-medium text-foreground">{invite.email}</span>
              </CardDescription>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>You'll join as</span>
                <Badge variant="outline">{capitalize(invite.role)}</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <form onSubmit={onSubmit} className="flex flex-col gap-4">
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
                  Accept invitation
                </Button>
              </form>
            </CardContent>
          </Card>
      ) : null}
    </AuthShell>
  );
}
