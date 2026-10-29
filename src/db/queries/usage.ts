import { and, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { Db } from "../index";
import { calls, tenants } from "../schema";

export interface UsageSummary {
  externalCustomerId: string | null;
  from: Date;
  to: Date;
  /** שניות של שיחות אמיתיות (נכנסות ויוצאות) */
  realSeconds: number;
  /** שניות של שיחות ניסיון מהדשבורד */
  testSeconds: number;
  totalSeconds: number;
  /** כל שיחה מעוגלת למעלה לדקה שלמה, ואז סכום */
  totalMinutesRoundedPerCall: number;
  callCount: number;
  /** כמה Vapi חייב על השיחות האלה */
  vapiCostUsd: number;
}

/**
 * השימוש של לקוח בטווח זמן. את הטווח, החבילה והחריגה מחליטה המערכת הראשית.
 * סופר רק שיחות שהסתיימו, לפי זמן תחילת השיחה. from כולל, to לא כולל.
 */
export async function getUsage(db: Db, tenantId: string, from: Date, to: Date): Promise<UsageSummary> {
  const [row] = await db
    .select({
      externalCustomerId: tenants.externalCustomerId,
      realSeconds: sql<string>`coalesce(sum(${calls.durationSeconds}) filter (where ${calls.type} <> 'test'), 0)`,
      testSeconds: sql<string>`coalesce(sum(${calls.durationSeconds}) filter (where ${calls.type} = 'test'), 0)`,
      roundedMinutes: sql<string>`coalesce(sum(ceil(${calls.durationSeconds} / 60.0)), 0)`,
      callCount: sql<string>`count(${calls.id})`,
      vapiCostUsd: sql<string>`coalesce(sum(${calls.costUsd}), 0)`,
    })
    .from(tenants)
    .leftJoin(
      calls,
      and(
        eq(calls.tenantId, tenants.id),
        eq(calls.status, "ended"),
        gte(calls.startedAt, from),
        lt(calls.startedAt, to),
      ),
    )
    .where(eq(tenants.id, tenantId))
    .groupBy(tenants.id);

  if (!row) throw new Error(`אין לקוח עם המזהה ${tenantId}`);

  const realSeconds = Number(row.realSeconds);
  const testSeconds = Number(row.testSeconds);
  return {
    externalCustomerId: row.externalCustomerId,
    from,
    to,
    realSeconds,
    testSeconds,
    totalSeconds: realSeconds + testSeconds,
    totalMinutesRoundedPerCall: Number(row.roundedMinutes),
    callCount: Number(row.callCount),
    vapiCostUsd: Number(row.vapiCostUsd),
  };
}

/**
 * סכום שניות השיחה של כמה לקוחות, לכל אחד בטווח שלו, בשאילתה אחת.
 * לרשימת הלקוחות בפאנל הניהול, כדי לא לשאול את ה-DB פעם לכל לקוח.
 */
export async function secondsByTenant(
  db: Db,
  ranges: { tenantId: string; from: Date; to: Date }[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (ranges.length === 0) return result;

  const windows = ranges.map((r) =>
    and(eq(calls.tenantId, r.tenantId), gte(calls.startedAt, r.from), lt(calls.startedAt, r.to)),
  );
  const rows = await db
    .select({
      tenantId: calls.tenantId,
      seconds: sql<string>`coalesce(sum(${calls.durationSeconds}), 0)`,
    })
    .from(calls)
    .where(and(eq(calls.status, "ended"), or(...windows)))
    .groupBy(calls.tenantId);

  for (const row of rows) result.set(row.tenantId, Number(row.seconds));
  return result;
}

/** שניות של שיחות ניסיון שהסתיימו, לכל לקוח, בשאילתה אחת. ליתרת הדמואים ברשימה. */
export async function testSecondsByTenant(db: Db, tenantIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (tenantIds.length === 0) return result;

  const rows = await db
    .select({
      tenantId: calls.tenantId,
      seconds: sql<string>`coalesce(sum(${calls.durationSeconds}), 0)`,
    })
    .from(calls)
    .where(and(inArray(calls.tenantId, tenantIds), eq(calls.type, "test"), eq(calls.status, "ended")))
    .groupBy(calls.tenantId);

  for (const row of rows) result.set(row.tenantId, Number(row.seconds));
  return result;
}

/** אותו חישוב, לפי המזהה של הלקוח במערכת הראשית. מחזיר null אם אין לקוח כזה. */
export async function getUsageByExternalCustomerId(
  db: Db,
  externalCustomerId: string,
  from: Date,
  to: Date,
): Promise<UsageSummary | null> {
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.externalCustomerId, externalCustomerId));
  if (!tenant) return null;
  return getUsage(db, tenant.id, from, to);
}
