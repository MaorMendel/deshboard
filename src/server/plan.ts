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

// ---------- התקופה שבה מציגים עלות ----------

/** ההפרש בין שעון ישראל ל-UTC ברגע נתון, במילישניות */
function jerusalemOffsetMs(at: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Jerusalem",
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(new Date(at))
      .map((x) => [x.type, Number(x.value)]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}

/** חצות של היום הראשון בחודש, בשעון ישראל. months מזיז קדימה או אחורה. */
export function startOfMonthJerusalem(now = new Date(), months = 0): Date {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", year: "numeric", month: "numeric" })
    .formatToParts(now)
    .reduce<Record<string, number>>((acc, x) => ({ ...acc, [x.type]: Number(x.value) }), {});
  const utcMidnight = Date.UTC(p.year, p.month - 1 + months, 1);
  // שני סבבים, למקרה שהמעבר לשעון קיץ נופל בין הניחוש לתוצאה
  let t = utcMidnight - jerusalemOffsetMs(utcMidnight);
  t = utcMidnight - jerusalemOffsetMs(t);
  return new Date(t);
}

export interface CostPeriod {
  from: Date;
  to: Date;
  /** cycle: המחזור של החבילה, כמו הדקות. month: חודש קלנדרי, ללקוח בלי חבילה. demo: מתחילת הדמו. */
  kind: "cycle" | "month" | "demo";
}

/**
 * באיזו תקופה מציגים את העלות של לקוח: אותה תקופה שבה סופרים לו דקות, כדי ששני המספרים יתאימו.
 * לקוח בלי חבילה: החודש הנוכחי (שעון ישראל). דמו: כל הדמו.
 */
export function costPeriod(tenant: Tenant, now = new Date()): CostPeriod {
  // בדמו כל השיחות שלו נספרות. בלי גבול תחתון, כדי ששעון לא מדויק לא יוציא שיחה מהחשבון.
  if (tenant.type === "demo") return { from: new Date(0), to: new Date(now.getTime() + 24 * 60 * 60 * 1000), kind: "demo" };
  if (tenant.planStartedAt) return { ...currentCycle(tenant.planStartedAt, now), kind: "cycle" };
  return { from: startOfMonthJerusalem(now), to: startOfMonthJerusalem(now, 1), kind: "month" };
}

/** התקופה הקודמת, להשוואה. לדמו אין. */
export function previousCostPeriod(period: CostPeriod): { from: Date; to: Date } | null {
  if (period.kind === "demo") return null;
  if (period.kind === "cycle") return { from: addMonths(period.from, -1), to: period.from };
  return { from: startOfMonthJerusalem(period.from, -1), to: period.from };
}
