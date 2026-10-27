import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { AuthShell } from "@/components/auth-shell";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });
    } catch {
      /* the endpoint always answers ok — never reveal whether the address exists */
    }
    setSent(true);
    setBusy(false);
  }

  return (
    <AuthShell
      footer={
        <p className="mt-4 text-center text-sm text-muted-foreground">
          Remembered it?{" "}
          <Link to="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
            Sign in
          </Link>
        </p>
      }
    >
      <Card>
          <CardHeader>
            <CardTitle className="text-xl">Reset your password</CardTitle>
            <CardDescription>We'll email you a link to set a new one.</CardDescription>
          </CardHeader>
          <CardContent>
            {sent ? (
              <div className="flex flex-col gap-3 text-sm text-muted-foreground">
                <p>
                  If an account exists for{" "}
                  <span className="font-medium text-foreground">{email}</span>, a password-reset link
                  is on its way. Check your inbox.
                </p>
                <Link
                  to="/login"
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  Back to sign in
                </Link>
              </div>
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
                <Button type="submit" variant="brand" disabled={busy || !email} className="mt-1">
                  {busy && <Spinner className="size-4 text-primary-foreground" />}
                  Send reset link
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
    </AuthShell>
  );
}
