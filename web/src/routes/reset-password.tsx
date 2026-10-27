import { useState, type FormEvent } from "react";
import { Link, getRouteApi, useNavigate } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { AuthShell } from "@/components/auth-shell";
import { toast } from "@/components/ui/toaster";

const routeApi = getRouteApi("/reset-password");

export function ResetPasswordPage() {
  const { token } = routeApi.useSearch();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Those passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await api("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      toast.success("Password updated — sign in with your new one.");
      await navigate({ to: "/login" });
    } catch (err) {
      setError((err as { detail?: string }).detail || "That reset link is invalid or has expired.");
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <Card>
          <CardHeader>
            <CardTitle className="text-xl">Set a new password</CardTitle>
            <CardDescription>
              {token ? "Choose a new password for your account." : "This reset link is missing its token."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {token ? (
              <form onSubmit={onSubmit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="password">New password</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="confirm">Confirm password</Label>
                  <Input
                    id="confirm"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
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
                  Update password
                </Button>
              </form>
            ) : (
              <Link
                to="/forgot-password"
                className="text-sm font-medium text-foreground underline-offset-4 hover:underline"
              >
                Request a new reset link
              </Link>
            )}
          </CardContent>
        </Card>
    </AuthShell>
  );
}
