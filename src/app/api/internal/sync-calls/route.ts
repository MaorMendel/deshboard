import { syncAllCalls } from "@/server/call-sync";
import { checkInternalAuth } from "@/server/internal-auth";
import { isVapiConfigured } from "@/server/vapi-client";

/**
 * POST /api/internal/sync-calls?hours=24
 * Authorization: Bearer <INTERNAL_API_SECRET>
 *
 * מושך מ-Vapi את כל השיחות שהשתנו בשעות האחרונות ומעדכן את טבלת calls.
 * כדאי להריץ כל כמה דקות (cron), כדי שהנתונים ב-DB יהיו עדכניים.
 */
export async function POST(request: Request) {
  const denied = checkInternalAuth(request);
  if (denied) return denied;
  if (!isVapiConfigured()) return Response.json({ error: "VAPI_PRIVATE_KEY לא מוגדר." }, { status: 503 });

  const hours = Math.min(Math.max(Number(new URL(request.url).searchParams.get("hours") ?? 24), 1), 24 * 62);
  try {
    const result = await syncAllCalls(new Date(Date.now() - hours * 60 * 60 * 1000));
    return Response.json({ hours, ...result });
  } catch (err) {
    console.error(err);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
