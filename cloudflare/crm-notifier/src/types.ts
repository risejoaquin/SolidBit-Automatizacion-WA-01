export interface NotifierEnv {
  // Public variables
  SUPABASE_URL: string;
  CRM_BUSINESS_ID: string;
  KAPSO_PHONE_NUMBER_ID: string;
  KAPSO_HANDOFF_TEMPLATE: string;
  KAPSO_HANDOFF_TEMPLATE_LANGUAGE?: string;
  ENABLE_KAPSO_HANDOFF_NOTICES?: string;
  WORKER_VERSION?: string;
  ENVIRONMENT?: string;

  // Cloudflare Secrets
  SUPABASE_SERVICE_ROLE_KEY: string;
  KAPSO_API_KEY?: string;
  KAPSO_WORKER_PHONE?: string;
}

export interface ClaimedTask {
  event_key: string;
  attempts: number;
}

export interface DrainResult {
  processed: number;
  accepted: number;
  failed: number;
  status: "completed" | "idle" | "disabled" | "misconfigured" | "error";
  reason?: string;
}
