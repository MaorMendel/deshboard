// החבילה של לקוח: מתי התחילה וכמה דקות יש בה בחודש.
// המחזור מתחדש כל חודש באותו יום שבו החבילה התחילה. החיוב עצמו נשאר במערכת הראשית.

import { getDb } from "@/db";
import { getUsage, secondsByTenant } from "@/db/queries/usage";
import type { Tenant } from "@/db/schema";

/** מוסיף חודשים לתאריך. יום שלא קיים בחודש היעד (למשל 31) נצמד ליום האחרון שלו. */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(day, lastDay));
  return result;
}

/** המחזור החודשי הנוכחי של חבילה שהתחילה בתאריך הנתון. from כולל, to לא כולל. */
export function currentCycle(planStartedAt: Date, now = new Date()): { from: Date; to: Date } {
  const months = Math.max(
    0,
    (now.getFullYear() - planStartedAt.getFullYear()) * 12 + (now.getMonth() - planStartedAt.getMonth()),
  );
  let from = addMonths(planStartedAt, months);
  if (from > now && months > 0) from = addMonths(planStartedAt, months - 1);
  return { from, to: addMonths(from, 1) };
}

export interface PlanUsage {
  limitMinutes: number;
  /** דקות שנוצלו במחזור הנוכחי: סכום השניות של כל השיחות, חלקי 60, בלי השארית */
  usedMinutes: number;
  cycleStart: Date;
  cycleEnd: Date;
}

/** הניצול במחזור הנוכחי, או null אם לא הוגדרה חבילה. מחושב מטבלת calls (שמסונכרנת מ-Vapi). */
export async function planUsage(tenant: Tenant, now = new Date()): Promise<PlanUsage | null> {
  if (!tenant.planStartedAt || !tenant.planMinutes) return null;
  const { from, to } = currentCycle(tenant.planStartedAt, now);
  const usage = await getUsage(getDb(), tenant.id, from, to);
  return {
    limitMinutes: tenant.planMinutes,
    usedMinutes: Math.floor(usage.totalSeconds / 60),
    cycleStart: from,
    cycleEnd: to,
  };
}

/** אותו חישוב לכמה לקוחות, בשאילתה אחת. לקוחות בלי חבילה לא מופיעים בתוצאה. */
export async function planUsageMany(tenants: Tenant[], now = new Date()): Promise<Map<string, PlanUsage>> {
  const cycles = tenants
    .filter((t) => t.planStartedAt && t.planMinutes)
    .map((t) => ({ tenant: t, ...currentCycle(t.planStartedAt!, now) }));

  const seconds = await secondsByTenant(
    getDb(),
    cycles.map((c) => ({ tenantId: c.tenant.id, from: c.from, to: c.to })),
  );

  return new Map(
    cycles.map((c) => [
      c.tenant.id,
      {
        limitMinutes: c.tenant.planMinutes!,
        usedMinutes: Math.floor((seconds.get(c.tenant.id) ?? 0) / 60),
        cycleStart: c.from,
        cycleEnd: c.to,
      },
    ]),
  );
}
