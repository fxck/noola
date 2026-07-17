import { api } from "@/lib/api";

// Auto satisfaction surveys — per-tenant toggles for delivering CSAT/NPS on ticket resolution.

export interface SurveySettings {
  csatEnabled: boolean;
  npsEnabled: boolean;
}

export async function fetchSurveySettings(): Promise<SurveySettings> {
  return (await api<{ settings: SurveySettings }>("/settings/surveys")).settings;
}

export async function updateSurveySettings(patch: Partial<SurveySettings>): Promise<SurveySettings> {
  return (await api<{ settings: SurveySettings }>("/settings/surveys", { method: "PUT", body: JSON.stringify(patch) })).settings;
}
