// מושך מ-Vapi את מצב השיחות ומעדכן את טבלת calls.
// לא נוגעים בהגדרות ה-server (webhooks) של ה-assistants, כדי לא לשבור חיבורים קיימים של המערכת שלך.

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { calls, tenants, type Call } from "@/db/schema";
import { config } from "./config";
import { isVapiConfigured, vapi, type VapiCall } from "./vapi-client";

/** שיחת ניסיון שעדיין "פתוחה" אחרי הזמן הזה נחשבת תקועה ונסגרת, כדי שלא תחסום שיחות חדשות */
const STALE_OPEN_CALL_MS = 3 * 60 * 60 * 1000;
/** שורה שנוצרה אבל Vapi לא החזיר לה מזהה (הבקשה נכשלה באמצע) */
const NEVER_STARTED_MS = 5 * 60 * 1000;

type CallStatus = Call["status"];
type CallType = Call["type"];

export function mapStatus(call: VapiCall): CallStatus {
  switch (call.status) {
    case "scheduled":
    case "queued":
    case "ringing":
      return "queued";
    case "in-progress":
    case "forwarding":
      return "in_progress";
    case "ended":
      return call.startedAt ? "ended" : "failed";
    default:
      return "failed";
  }
}

export function mapType(call: VapiCall): CallType {
  return call.type === "outboundPhoneCall" ? "outbound" : "inbound";
}

export function durationSeconds(call: VapiCall): number | null {
  if (call.startedAt && call.endedAt) {
    return Math.max(0, Math.round((Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000));
  }
  return call.status === "ended" ? 0 : null;
}

/** השדות שמתעדכנים מ-Vapi. סוג השיחה לא ביניהם, כדי ששיחת ניסיון תישאר "test". */
function fieldsFromVapi(call: VapiCall) {
  return {
    status: mapStatus(call),
    startedAt: call.startedAt ? new Date(call.startedAt) : null,
    endedAt: call.endedAt ? new Date(call.endedAt) : null,
    durationSeconds: durationSeconds(call),
    costUsd: call.cost != null ? call.cost.toFixed(4) : null,
    costBreakdown: call.costBreakdown ?? null,
    endedReason: call.endedReason ?? null,
  };
}

/** מעדכן שיחות ניסיון פתוחות (של לקוח אחד או של כולם) לפי המצב שלהן ב-Vapi */
export async function refreshOpenTestCalls(tenantId?: string): Promise<number> {
  const db = getDb();
  const open = await db
    .select()
    .from(calls)
    .where(
      and(
        eq(calls.type, "test"),
        inArray(calls.status, ["queued", "in_progress"]),
        tenantId ? eq(calls.tenantId, tenantId) : undefined,
      ),
    );

  let updated = 0;
  for (const row of open) {
    const age = Date.now() - row.createdAt.getTime();

    if (!row.vapiCallId) {
      if (age > NEVER_STARTED_MS) {
        await db.update(calls).set({ status: "failed", endedReason: "not-started" }).where(eq(calls.id, row.id));
        updated++;
      }
      continue;
    }

    try {
      if (!isVapiConfigured()) throw new Error("Vapi not configured");
      const call = await vapi.getCall(row.vapiCallId);
      await db.update(calls).set(fieldsFromVapi(call)).where(eq(calls.id, row.id));
      updated++;
    } catch (err) {
      if (age > STALE_OPEN_CALL_MS) {
        await db.update(calls).set({ status: "failed", endedReason: "stale" }).where(eq(calls.id, row.id));
        updated++;
      } else {
        console.warn(`לא הצלחתי לעדכן את שיחה ${row.vapiCallId}:`, (err as Error).message);
      }
    }
  }
  return updated;
}

/** כל השיחות של assistant שהשתנו מאז התאריך, דף אחרי דף (Vapi מחזיר עד 1000 בכל פעם) */
async function* callsUpdatedSince(assistantId: string, since: Date): AsyncGenerator<VapiCall[]> {
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const batch = await vapi.listCalls({ assistantId, updatedAtGe: since.toISOString(), createdAtLt: cursor });
    yield batch;
    if (batch.length < 1000) return;
    // הדף הבא: שיחות שנוצרו לפני הישנה ביותר בדף הזה
    cursor = batch.reduce((min, c) => (c.createdAt < min ? c.createdAt : min), batch[0].createdAt);
  }
}

/** מושך את כל השיחות של ה-assistant של לקוח שהשתנו מאז התאריך, ומכניס או מעדכן אותן */
export async function syncTenantCalls(tenant: { id: string; vapiAssistantId: string | null }, since: Date) {
  if (!tenant.vapiAssistantId) return { fetched: 0 };
  const db = getDb();
  let fetched = 0;

  for await (const batch of callsUpdatedSince(tenant.vapiAssistantId, since)) {
    for (const call of batch) {
      const fields = fieldsFromVapi(call);
      await db
        .insert(calls)
        .values({
          tenantId: tenant.id,
          vapiCallId: call.id,
          type: mapType(call),
          vapiAssistantId: call.assistantId ?? tenant.vapiAssistantId,
          customerNumber: call.customer?.number ?? null,
          createdAt: new Date(call.createdAt),
          ...fields,
        })
        .onConflictDoUpdate({ target: calls.vapiCallId, set: fields });
    }
    fetched += batch.length;
  }
  return { fetched };
}

/**
 * שיחות הניסיון של הדמואים רצות על ה-assistant המשותף, ולכן syncTenantCalls לא רואה אותן.
 * עד עכשיו הן התעדכנו רק כל עוד היו פתוחות, אבל העלות הסופית (כולל הסיכום שאחרי השיחה) מגיעה
 * מ-Vapi קצת אחרי הסיום. כאן מעדכנים את השורות שכבר קיימות אצלנו, לפי המזהה של השיחה.
 * שיחה של ה-assistant המשותף שלא נוצרה מהדשבורד לא נכנסת, כי אין לה לקוח.
 */
export async function syncDemoCalls(since: Date): Promise<{ fetched: number; updated: number }> {
  const demoAssistantId = config.vapi.demoAssistantId();
  if (!demoAssistantId) return { fetched: 0, updated: 0 };
  const db = getDb();
  let fetched = 0;
  let updated = 0;

  for await (const batch of callsUpdatedSince(demoAssistantId, since)) {
    fetched += batch.length;
    if (!batch.length) continue;
    const known = await db
      .select({ vapiCallId: calls.vapiCallId })
      .from(calls)
      .where(inArray(calls.vapiCallId, batch.map((c) => c.id)));
    const knownIds = new Set(known.map((k) => k.vapiCallId));
    for (const call of batch) {
      if (!knownIds.has(call.id)) continue;
      await db.update(calls).set(fieldsFromVapi(call)).where(eq(calls.vapiCallId, call.id));
      updated++;
    }
  }
  return { fetched, updated };
}

/**
 * מתי סונכרן לאחרונה כל לקוח. מונע משיכה מ-Vapi בכל טעינת דף:
 * בלי זה, רענון או מעבר בין דפים מחכים לכמה סבבים מול Vapi בכל פעם.
 * נשמר בזיכרון התהליך, ולכן זו רק הקטנת עומס, לא נכונות: הפקודה ו-cron תמיד מסנכרנים.
 */
const lastSyncAt = new Map<string, number>();
export const SYNC_MIN_INTERVAL_MS = 60_000;

const DEMO_SYNC_KEY = "demo-assistant";

/** כמו syncDemoCalls, אבל מדלג אם סונכרן לפני פחות מדקה */
export async function syncDemoCallsIfStale(since: Date, minIntervalMs = SYNC_MIN_INTERVAL_MS) {
  if (Date.now() - (lastSyncAt.get(DEMO_SYNC_KEY) ?? 0) < minIntervalMs) return { fetched: 0, updated: 0, skipped: true };
  lastSyncAt.set(DEMO_SYNC_KEY, Date.now());
  try {
    return await syncDemoCalls(since);
  } catch (err) {
    lastSyncAt.delete(DEMO_SYNC_KEY);
    throw err;
  }
}

/** כמו syncTenantCalls, אבל מדלג אם סונכרן לפני פחות מדקה */
export async function syncTenantCallsIfStale(
  tenant: { id: string; vapiAssistantId: string | null },
  since: Date,
  minIntervalMs = SYNC_MIN_INTERVAL_MS,
): Promise<{ fetched: number; skipped?: true }> {
  if (Date.now() - (lastSyncAt.get(tenant.id) ?? 0) < minIntervalMs) return { fetched: 0, skipped: true };
  // מסמנים לפני הסנכרון, כדי ששתי בקשות במקביל לא ימשכו את אותו דבר פעמיים
  lastSyncAt.set(tenant.id, Date.now());
  try {
    return await syncTenantCalls(tenant, since);
  } catch (err) {
    lastSyncAt.delete(tenant.id);
    throw err;
  }
}

/** סנכרון מלא: שיחות ניסיון פתוחות, שיחות הדמואים, ואז כל השיחות של כל הלקוחות המחוברים */
export async function syncAllCalls(since: Date) {
  const db = getDb();
  const refreshedTests = await refreshOpenTestCalls();
  const demos = await syncDemoCalls(since).catch((err: Error) => ({ fetched: 0, updated: 0, error: err.message }));
  const connected = await db
    .select({ id: tenants.id, name: tenants.name, vapiAssistantId: tenants.vapiAssistantId })
    .from(tenants)
    .where(and(eq(tenants.type, "customer"), isNotNull(tenants.vapiAssistantId)));

  const results: { tenant: string; fetched: number; error?: string }[] = [];
  for (const t of connected) {
    try {
      const r = await syncTenantCalls(t, since);
      results.push({ tenant: t.name, fetched: r.fetched });
    } catch (err) {
      results.push({ tenant: t.name, fetched: 0, error: (err as Error).message });
    }
  }
  return { refreshedTests, demos, tenants: results };
}

/** כמה שניות דמו כבר נוצלו (שיחות ניסיון שהסתיימו) */
export async function demoUsedSeconds(tenantId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ used: sql<string>`coalesce(sum(${calls.durationSeconds}), 0)` })
    .from(calls)
    .where(and(eq(calls.tenantId, tenantId), eq(calls.type, "test"), eq(calls.status, "ended")));
  return Number(row.used);
}

