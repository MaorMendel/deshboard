// מושך מ-Vapi את מצב השיחות ומעדכן את טבלת calls.
// לא נוגעים בהגדרות ה-server (webhooks) של ה-assistants, כדי לא לשבור חיבורים קיימים של המערכת שלך.

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { calls, syncState, tenants, type Call } from "@/db/schema";
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

// ---------- שמירה במנות ----------

/** העמודות שמתעדכנות כששיחה כבר קיימת (כמו fieldsFromVapi). סוג השיחה לא ביניהן. */
const UPDATED_ON_CONFLICT = [
  "status",
  "startedAt",
  "endedAt",
  "durationSeconds",
  "costUsd",
  "costBreakdown",
  "endedReason",
] as const satisfies readonly (keyof ReturnType<typeof fieldsFromVapi>)[];

const setFromExcluded = Object.fromEntries(
  UPDATED_ON_CONFLICT.map((key) => [key, sql.raw(`excluded."${calls[key].name}"`)]),
);

/**
 * מכניס או מעדכן הרבה שיחות בשאילתה אחת (לכל 500), במקום שאילתה לכל שיחה.
 * מול Supabase כל שאילתה היא נסיעה הלוך-חזור לפרנקפורט, ו-300 כאלה ברצף לקחו שניות.
 */
async function upsertCalls(rows: (typeof calls.$inferInsert)[]) {
  // אותה שיחה פעמיים באותה שאילתה היא שגיאה ב-Postgres, ולכן קודם מאחדים לפי המזהה
  const unique = [...new Map(rows.map((r) => [r.vapiCallId, r])).values()];
  const db = getDb();
  for (let i = 0; i < unique.length; i += 500) {
    await db
      .insert(calls)
      .values(unique.slice(i, i + 500))
      .onConflictDoUpdate({ target: calls.vapiCallId, set: setFromExcluded });
  }
}

// ---------- סנכרון מצטבר ----------

/** חפיפה בין סנכרון לסנכרון, למקרה שהשעונים אצלנו וב-Vapi לא מדויקים */
const OVERLAP_MS = 10 * 60 * 1000;
/** בטעינת דף: לא לפנות ל-Vapi שוב אם סונכרן לפני פחות מזה */
export const SYNC_MIN_INTERVAL_MS = 60_000;

export const tenantSyncKey = (tenantId: string) => `tenant:${tenantId}`;
export const DEMO_SYNC_KEY = "demo-assistant";

/** קוד השגיאה של Postgres לטבלה שלא קיימת: מיגרציה 0006 עוד לא הורצה */
function isMissingTable(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "42P01" || e?.cause?.code === "42P01";
}

/** null כשעוד לא סונכרן, "missing" כשהטבלה עוד לא קיימת */
async function readSyncState(key: string) {
  try {
    const [row] = await getDb().select().from(syncState).where(eq(syncState.key, key));
    return row ?? null;
  } catch (err) {
    if (isMissingTable(err)) return "missing" as const;
    throw err;
  }
}

/** מתי הסתיים בהצלחה הסנכרון האחרון (tenantSyncKey או DEMO_SYNC_KEY). null אם עוד לא, או אם אין טבלה. */
export async function lastSyncedAt(key: string): Promise<Date | null> {
  const state = await readSyncState(key);
  return state && state !== "missing" ? state.syncedAt : null;
}

export interface SyncResult {
  fetched: number;
  /** לא פנינו ל-Vapi, כי סונכרן ממש עכשיו */
  skipped?: true;
}

/**
 * הלב של הסנכרון: מחליט ממתי למשוך, מושך, שומר, ומעדכן את המצב.
 * - אם השיחות אצלנו כבר שלמות מ-since: מושכים רק מה שהשתנה מאז הסנכרון הקודם (פחות חפיפה).
 * - אחרת (פעם ראשונה, או שמבקשים תקופה מוקדמת יותר): מושכים הכול מ-since.
 * המצב מתעדכן רק אחרי שהכול נשמר, כך שסנכרון שנכשל באמצע פשוט חוזר על עצמו בפעם הבאה.
 */
async function syncIncrementally(
  key: string,
  since: Date,
  minIntervalMs: number,
  fetchAndSave: (from: Date) => Promise<number>,
): Promise<SyncResult> {
  const state = await readSyncState(key);
  const startedAt = new Date();

  // בלי הטבלה: כמו פעם, הכול מ-since בכל פעם
  if (state === "missing") return { fetched: await fetchAndSave(since) };

  const covered = state != null && state.coveredFrom <= since;
  if (covered && startedAt.getTime() - state.syncedAt.getTime() < minIntervalMs) return { fetched: 0, skipped: true };

  const from = covered ? new Date(state.syncedAt.getTime() - OVERLAP_MS) : since;
  const fetched = await fetchAndSave(from);

  const coveredFrom = covered ? state.coveredFrom : since;
  await getDb()
    .insert(syncState)
    .values({ key, coveredFrom, syncedAt: startedAt })
    .onConflictDoUpdate({
      target: syncState.key,
      // שני סנכרונים במקביל: לא חוזרים אחורה בזמן
      set: {
        coveredFrom: sql`least(${syncState.coveredFrom}, excluded.covered_from)`,
        syncedAt: sql`greatest(${syncState.syncedAt}, excluded.synced_at)`,
      },
    });
  return { fetched };
}

/**
 * מוודא שכל השיחות של ה-assistant של הלקוח שהשתנו מאז since נמצאות אצלנו ומעודכנות.
 * בפועל מושך מ-Vapi רק מה שהשתנה מאז הסנכרון הקודם.
 * minIntervalMs: אם סונכרן לפני פחות מזה, לא פונים ל-Vapi בכלל (ברירת מחדל: תמיד פונים).
 */
export async function syncTenantCalls(
  tenant: { id: string; vapiAssistantId: string | null },
  since: Date,
  { minIntervalMs = 0 }: { minIntervalMs?: number } = {},
): Promise<SyncResult> {
  const assistantId = tenant.vapiAssistantId;
  if (!assistantId) return { fetched: 0 };

  return syncIncrementally(tenantSyncKey(tenant.id), since, minIntervalMs, async (from) => {
    let fetched = 0;
    for await (const batch of callsUpdatedSince(assistantId, from)) {
      await upsertCalls(
        batch.map((call) => ({
          tenantId: tenant.id,
          vapiCallId: call.id,
          type: mapType(call),
          vapiAssistantId: call.assistantId ?? assistantId,
          customerNumber: call.customer?.number ?? null,
          createdAt: new Date(call.createdAt),
          ...fieldsFromVapi(call),
        })),
      );
      fetched += batch.length;
    }
    return fetched;
  });
}

/** כמו syncTenantCalls, אבל מדלג אם סונכרן לפני פחות מדקה. לטעינת דפים. */
export function syncTenantCallsIfStale(
  tenant: { id: string; vapiAssistantId: string | null },
  since: Date,
  minIntervalMs = SYNC_MIN_INTERVAL_MS,
): Promise<SyncResult> {
  return syncTenantCalls(tenant, since, { minIntervalMs });
}

/**
 * שיחות הניסיון של הדמואים רצות על ה-assistant המשותף, ולכן syncTenantCalls לא רואה אותן.
 * העלות הסופית של שיחה (כולל הסיכום שאחריה) מגיעה מ-Vapi קצת אחרי הסיום, ולכן מעדכנים אותן כאן.
 * רק שורות שכבר קיימות אצלנו: שיחה של ה-assistant המשותף שלא נוצרה מהדשבורד לא נכנסת, כי אין לה לקוח.
 */
export async function syncDemoCalls(
  since: Date,
  { minIntervalMs = 0 }: { minIntervalMs?: number } = {},
): Promise<SyncResult> {
  const demoAssistantId = config.vapi.demoAssistantId();
  if (!demoAssistantId) return { fetched: 0 };
  const db = getDb();

  return syncIncrementally(DEMO_SYNC_KEY, since, minIntervalMs, async (from) => {
    let fetched = 0;
    for await (const batch of callsUpdatedSince(demoAssistantId, from)) {
      fetched += batch.length;
      if (!batch.length) continue;
      const known = await db
        .select({ vapiCallId: calls.vapiCallId, tenantId: calls.tenantId, type: calls.type })
        .from(calls)
        .where(inArray(calls.vapiCallId, batch.map((c) => c.id)));
      const byId = new Map(known.map((k) => [k.vapiCallId, k]));
      await upsertCalls(
        batch.flatMap((call) => {
          const row = byId.get(call.id);
          return row ? [{ tenantId: row.tenantId, vapiCallId: call.id, type: row.type, ...fieldsFromVapi(call) }] : [];
        }),
      );
    }
    return fetched;
  });
}

/** סנכרון מלא: שיחות ניסיון פתוחות, שיחות הדמואים, ואז כל השיחות של כל הלקוחות המחוברים */
export async function syncAllCalls(since: Date) {
  const db = getDb();
  const refreshedTests = await refreshOpenTestCalls();
  const demos = await syncDemoCalls(since).catch((err: Error) => ({ fetched: 0, error: err.message }));
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

