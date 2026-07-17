import { withTenant } from "@repo/db";
import { projectSurveys } from "./seedflows.js";

// Auto satisfaction surveys — when a ticket resolves, optionally deliver a CSAT and/or NPS
// prompt back into the conversation (as an agent message, so it reaches the customer through
// whatever channel the ticket lives on — the messenger widget, email, etc.). Per-tenant toggles.
//
// Dogfood L2: this module is now the SETTINGS EDITOR only. Delivery moved to the automations
// engine — upsertSurveySettings re-projects the toggles into a managed `ticket.closed → survey`
// seed automation (projectSurveys), and the `survey` action's flow_dedupe guard replaces the old
// survey_requests bookkeeping. surveyBody stays here (the shared prompt copy the action reuses).

export interface SurveySettings {
  csatEnabled: boolean;
  npsEnabled: boolean;
}

const DEFAULT: SurveySettings = { csatEnabled: false, npsEnabled: false };

export async function getSurveySettings(tenantId: string): Promise<SurveySettings> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT csat_enabled, nps_enabled FROM survey_settings LIMIT 1`);
    if (!r.rowCount) return DEFAULT;
    return { csatEnabled: r.rows[0].csat_enabled, npsEnabled: r.rows[0].nps_enabled };
  });
}

export async function upsertSurveySettings(
  tenantId: string,
  patch: Partial<SurveySettings>,
): Promise<SurveySettings> {
  const settings = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO survey_settings (tenant_id, csat_enabled, nps_enabled)
       VALUES (current_tenant(), COALESCE($1, false), COALESCE($2, false))
       ON CONFLICT (tenant_id) DO UPDATE SET
         csat_enabled = COALESCE($1, survey_settings.csat_enabled),
         nps_enabled  = COALESCE($2, survey_settings.nps_enabled),
         updated_at   = now()
       RETURNING csat_enabled, nps_enabled`,
      [patch.csatEnabled ?? null, patch.npsEnabled ?? null],
    );
    return { csatEnabled: r.rows[0].csat_enabled, npsEnabled: r.rows[0].nps_enabled };
  });
  await projectSurveys(tenantId); // re-project so the engine delivers surveys per the new toggles
  return settings;
}

export function surveyBody(csat: boolean, nps: boolean): string {
  const lines = ["Thanks for reaching out — we've marked this resolved. 🎉"];
  if (csat) lines.push("How would you rate the support you received? Reply with 1–5 stars.");
  if (nps) lines.push("And how likely are you to recommend us to a colleague? Reply with a number 0–10.");
  lines.push("Your feedback helps us improve — thank you!");
  return lines.join("\n\n");
}

// (deliverSurveyOnClose retired — the `ticket.closed → survey` seed automation delivers surveys
//  now; the `survey` action's flow_dedupe guard replaces the survey_requests dedupe row.)
