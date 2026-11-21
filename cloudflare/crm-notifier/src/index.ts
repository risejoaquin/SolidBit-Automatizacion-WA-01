import type { NotifierEnv } from "./types.ts";
import { drainOutbox } from "./drain.ts";

function jsonResponse(status: number, data: any): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export default {
  async fetch(request: Request, env: NotifierEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" || url.pathname === "/health/") {
      return jsonResponse(200, {
        status: "healthy",
        service: "crm-kapso-notifier",
        version: env.WORKER_VERSION || "1.0.0",
        environment: env.ENVIRONMENT || "production",
        notices_enabled: env.ENABLE_KAPSO_HANDOFF_NOTICES === "true"
      });
    }

    if (request.method === "POST" && (url.pathname === "/dispatch" || url.pathname === "/dispatch/")) {
      const result = await drainOutbox(env);
      return jsonResponse(200, result);
    }

    return jsonResponse(404, { error: "Not found" });
  },

  async scheduled(event: ScheduledEvent, env: NotifierEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(drainOutbox(env));
  }
};
