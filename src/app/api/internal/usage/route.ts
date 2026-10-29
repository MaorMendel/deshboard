import { getDb } from "@/db";
import { getUsageByExternalCustomerId } from "@/db/queries/usage";
import { findTenant } from "@/server/admin-service";
import { syncTenantCalls } from "@/server/call-sync";
import { checkInternalAuth } from "@/server/internal-auth";
import { isVapiConfigured } from "@/server/vapi-client";

/**
 * GET /api/internal/usage?customer=<external_customer_id>&from=<ISO>&to=<ISO>
 * Authorization: Bearer <INTERNAL_API_SECRET>
 *
 * מחזיר את הדקות של הלקוח בטווח: שיחות אמיתיות ושיחות ניסיון.
 * לפני החישוב מושך מ-Vapi את השיחות של הטווח, כדי שהמספרים יהיו מעודכנים (אפשר לכבות עם sync=0).
 */
export async function GET(request: Request) {
  const denied = checkInternalAuth(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const customer = url.searchParams.get("customer");
  const from = new Date(url.searchParams.get("from") ?? "");
  const to = new Date(url.searchParams.get("to") ?? "");
  if (!customer || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    return Response.json(
      { error: "צריך customer, from ו-to (תאריכים בפורמט ISO, from לפני to)." },
      { status: 400 },
    );
  }

  try {
    const tenant = await findTenant(customer).catch(() => null);
    if (!tenant || tenant.externalCustomerId !== customer) {
      return Response.json({ error: `לא נמצא לקוח ${customer}.` }, { status: 404 });
    }
    if (url.searchParams.get("sync") !== "0" && isVapiConfigured()) {
      await syncTenantCalls(tenant, from);
    }
    const usage = await getUsageByExternalCustomerId(getDb(), customer, from, to);
    return Response.json(usage);
  } catch (err) {
    console.error(err);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
