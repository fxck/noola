import { api } from "@/lib/api";

// Public (unauthenticated) instance shape — the login/signup pages read it to decide whether
// workspace self-signup exists and whether demo affordances should render. Fails open to the
// multi-tenant defaults so a transient API error never locks the login page down harder than
// the server would.

export interface InstanceConfig {
  signupsEnabled: boolean;
  demoMode: boolean;
  /** SMTP configured — invite / password-reset emails actually deliver. */
  emailEnabled: boolean;
}

export async function fetchInstanceConfig(): Promise<InstanceConfig> {
  try {
    return await api<InstanceConfig>("/public/instance");
  } catch {
    return { signupsEnabled: true, demoMode: true, emailEnabled: true };
  }
}
