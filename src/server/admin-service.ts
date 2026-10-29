// פעולות ניהול: לקוחות, דמואים וקישורים.
// כרגע מופעלות מהסקריפטים ב-scripts/cli.ts. פאנל הניהול ישתמש באותן פונקציות.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { BotSettings } from "@/lib/types";
import { getDb } from "@/db";
import { decryptAccessKey, encryptAccessKey, generateAccessKey, hashAccessKey } from "@/db/access-keys";
import { accessLinks, auditLog, botVersions, calls, tenants, type AccessLink, type Call, type Tenant } from "@/db/schema";
import { testSecondsByTenant } from "@/db/queries/usage";
import { demoUsedSeconds, refreshOpenTestCalls, syncTenantCallsIfStale } from "./call-sync";
import { config } from "./config";
import { ServiceError } from "./errors";
import { currentCycle, planUsage, planUsageMany, type PlanUsage } from "./plan";
import { PROMPT_MAX } from "@/lib/validation";
import { buildVoice, modelWithPrompt, promptFromModel, settingsFromAssistant, toAssistantFields } from "./vapi";
import { isVapiConfigured, vapi } from "./vapi-client";
import { ensureVoice, selectableVoices } from "./voice-catalog";

const E164 = /^\+[1-9][0-9]{7,14}$/;

/** הופך מספר ישראלי מקומי (050-1234567) לפורמט בינלאומי (+972501234567) */
export function normalizePhone(input: string): string {
  const digits = input.replace(/[^\d+]/g, "");
  const e164 = digits.startsWith("+") ? digits : digits.startsWith("0") ? `+972${digits.slice(1)}` : `+${digits}`;
  if (!E164.test(e164)) throw new ServiceError("validation", `המספר ${input} לא תקין.`);
  return e164;
}

export function linkUrl(key: string): string {
  return `${config.appUrl()}/b/${key}`;
}

/** מוצא לקוח לפי המזהה במערכת הראשית, או לפי ה-id הפנימי */
export async function findTenant(ref: string): Promise<Tenant> {
  const db = getDb();
  const isUuid = /^[0-9a-f-]{36}$/i.test(ref);
  const [t] = await db
    .select()
    .from(tenants)
    .where(isUuid ? eq(tenants.id, ref) : eq(tenants.externalCustomerId, ref));
  if (!t) throw new ServiceError("validation", `לא נמצא לקוח ${ref}.`);
  return t;
}

async function createWithFirstVersion(input: typeof tenants.$inferInsert, settings: BotSettings, linkLabel: string) {
  const db = getDb();
  const key = generateAccessKey();
  const tenant = await db.transaction(async (tx) => {
    const [t] = await tx.insert(tenants).values(input).returning();
    const [v] = await tx
      .insert(botVersions)
      .values({ tenantId: t.id, version: 1, settings, createdByType: "admin" })
      .returning({ id: botVersions.id });
    const [updated] = await tx.update(tenants).set({ currentVersionId: v.id }).where(eq(tenants.id, t.id)).returning();
    await tx.insert(accessLinks).values({
      tenantId: t.id,
      tokenHash: hashAccessKey(key),
      tokenEncrypted: encryptAccessKey(key),
      label: linkLabel,
    });
    await tx.insert(auditLog).values({ tenantId: t.id, actorType: "admin", action: "tenant.create", after: { ...input, settings } });
    return updated;
  });
  return { tenant, url: linkUrl(key) };
}

export interface NewCustomerInput {
  name: string;
  externalCustomerId: string;
  vapiAssistantId: string;
  vapiPhoneNumberId?: string;
  botPhoneDisplay?: string;
  verifiedPhone?: string;
  linkLabel?: string;
  planStartedAt?: Date;
  planMinutes?: number;
}

/**
 * מחבר לקוח קיים: קורא מ-Vapi את ההגדרות הנוכחיות של ה-assistant שלו (קול, פתיח, סגירה),
 * שומר אותן כגרסה הראשונה, ומנפיק קישור.
 */
export async function createCustomer(input: NewCustomerInput) {
  if (!isVapiConfigured()) throw new ServiceError("not_configured", "צריך להגדיר VAPI_PRIVATE_KEY כדי לחבר לקוח.");
  const assistant = await vapi.getAssistant(input.vapiAssistantId);

  let voiceId: string;
  if (assistant.voice?.provider && assistant.voice.voiceId != null) {
    voiceId = (await ensureVoice(assistant.voice, `קול מ-${assistant.name ?? input.name}`)).id;
  } else {
    const [first] = await selectableVoices();
    if (!first) throw new ServiceError("validation", "ל-assistant אין קול, ואין קולות פעילים בקטלוג.");
    voiceId = first.id;
  }

  return createWithFirstVersion(
    {
      name: input.name,
      type: "customer",
      externalCustomerId: input.externalCustomerId,
      vapiAssistantId: input.vapiAssistantId,
      vapiPhoneNumberId: input.vapiPhoneNumberId ?? null,
      botPhoneDisplay: input.botPhoneDisplay ?? null,
      verifiedPhone: input.verifiedPhone ? normalizePhone(input.verifiedPhone) : null,
      planStartedAt: input.planStartedAt ?? null,
      planMinutes: input.planMinutes ?? null,
    },
    settingsFromAssistant(assistant, voiceId),
    input.linkLabel ?? input.name,
  );
}

export interface NewDemoInput {
  name: string;
  verifiedPhone?: string;
  minutes?: number;
  days?: number;
}

/** יוצר דמו עם הגדרות התחלתיות ומנפיק קישור */
export async function createDemo(input: NewDemoInput) {
  const [voice] = await selectableVoices();
  if (!voice) throw new ServiceError("validation", "אין קולות פעילים בקטלוג. צריך להפעיל לפחות קול אחד.");
  const minutes = input.minutes ?? 5;
  const days = input.days ?? 7;
  return createWithFirstVersion(
    {
      name: input.name,
      type: "demo",
      demoSecondsLimit: Math.round(minutes * 60),
      demoExpiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
      verifiedPhone: input.verifiedPhone ? normalizePhone(input.verifiedPhone) : null,
    },
    {
      voiceId: voice.id,
      firstSpeaker: "bot",
      openingMessage: `שלום, הגעתם ל${input.name}. איך אפשר לעזור?`,
      closingMessage: "תודה ולהתראות.",
      prompt: "",
    },
    "דמו",
  );
}

/** מנפיק קישור חדש. כברירת מחדל מבטל את כל הקישורים הקודמים של הלקוח. */
export async function issueLink(ref: string, opts: { label?: string; revokeOthers?: boolean } = {}) {
  const tenant = await findTenant(ref);
  const db = getDb();
  const key = generateAccessKey();
  await db.transaction(async (tx) => {
    if (opts.revokeOthers ?? true) {
      await tx
        .update(accessLinks)
        .set({ revokedAt: new Date() })
        .where(and(eq(accessLinks.tenantId, tenant.id), isNull(accessLinks.revokedAt)));
    }
    await tx.insert(accessLinks).values({
      tenantId: tenant.id,
      tokenHash: hashAccessKey(key),
      tokenEncrypted: encryptAccessKey(key),
      label: opts.label ?? tenant.name,
    });
    await tx.insert(auditLog).values({ tenantId: tenant.id, actorType: "admin", action: "link.create", after: { label: opts.label ?? tenant.name } });
  });
  return { tenant, url: linkUrl(key) };
}

/** מבטל את כל הקישורים הפעילים של לקוח */
export async function revokeLinks(ref: string) {
  const tenant = await findTenant(ref);
  const db = getDb();
  const revoked = await db
    .update(accessLinks)
    .set({ revokedAt: new Date() })
    .where(and(eq(accessLinks.tenantId, tenant.id), isNull(accessLinks.revokedAt)))
    .returning({ id: accessLinks.id });
  await db.insert(auditLog).values({ tenantId: tenant.id, actorType: "admin", action: "link.revoke", after: { count: revoked.length } });
  return { tenant, revoked: revoked.length };
}

/**
 * הופך דמו ללקוח משלם ומחבר אותו ל-assistant שלו.
 * ההגדרות שהוא בחר בדמו (קול, פתיח, סגירה) נשלחות ל-assistant, כך שהבוט שבנה בדמו הוא זה שעולה.
 */
export async function convertDemo(
  ref: string,
  input: { externalCustomerId: string; vapiAssistantId: string; vapiPhoneNumberId?: string; botPhoneDisplay?: string },
) {
  const tenant = await findTenant(ref);
  if (tenant.type !== "demo") throw new ServiceError("validation", `${tenant.name} כבר לקוח משלם.`);
  if (!isVapiConfigured()) throw new ServiceError("not_configured", "צריך להגדיר VAPI_PRIVATE_KEY כדי לחבר לקוח.");
  const db = getDb();

  const [version] = tenant.currentVersionId
    ? await db.select().from(botVersions).where(eq(botVersions.id, tenant.currentVersionId))
    : [];
  if (version) {
    const [voice] = (await selectableVoices(version.settings.voiceId)).filter((v) => v.id === version.settings.voiceId);
    if (voice) {
      const assistant = await vapi.getAssistant(input.vapiAssistantId);
      const fields = toAssistantFields(version.settings, buildVoice(voice, assistant.voice));
      // גם ההנחיות שנכתבו בדמו עוברות ל-assistant, אם יש כאלה
      const prompt = (version.settings.prompt ?? "").trim();
      if (prompt && assistant.model) fields.model = modelWithPrompt(assistant.model, prompt);
      await vapi.updateAssistant(input.vapiAssistantId, fields);
    }
  }

  const [updated] = await db
    .update(tenants)
    .set({
      type: "customer",
      externalCustomerId: input.externalCustomerId,
      vapiAssistantId: input.vapiAssistantId,
      vapiPhoneNumberId: input.vapiPhoneNumberId ?? null,
      botPhoneDisplay: input.botPhoneDisplay ?? null,
      demoSecondsLimit: null,
      demoExpiresAt: null,
    })
    .where(eq(tenants.id, tenant.id))
    .returning();
  await db.insert(auditLog).values({ tenantId: tenant.id, actorType: "admin", action: "demo.convert", before: tenant, after: updated });
  return updated;
}

/** עדכון החבילה של לקוח: ממתי היא נספרת וכמה דקות יש בה בחודש */
export async function updatePlan(ref: string, plan: { startedAt: Date | null; minutes: number | null }) {
  const tenant = await findTenant(ref);
  if (plan.minutes !== null && (!Number.isInteger(plan.minutes) || plan.minutes <= 0)) {
    throw new ServiceError("validation", "גודל החבילה צריך להיות מספר שלם של דקות, גדול מאפס.");
  }
  if ((plan.minutes === null) !== (plan.startedAt === null)) {
    throw new ServiceError("validation", "חבילה צריכה גם תאריך התחלה וגם דקות. כדי להסיר אותה, מרוקנים את שניהם.");
  }
  const db = getDb();
  const [updated] = await db
    .update(tenants)
    .set({ planStartedAt: plan.startedAt, planMinutes: plan.minutes })
    .where(eq(tenants.id, tenant.id))
    .returning();
  await db.insert(auditLog).values({
    tenantId: tenant.id,
    actorType: "admin",
    action: "plan.update",
    before: { planStartedAt: tenant.planStartedAt, planMinutes: tenant.planMinutes },
    after: { planStartedAt: plan.startedAt, planMinutes: plan.minutes },
  });
  return updated;
}

/** הפרומפט של ה-assistant (הודעת ה-system), לקריאה בפאנל הניהול */
export async function getAssistantPrompt(ref: string): Promise<{ prompt: string; model: string | null }> {
  const tenant = await findTenant(ref);
  if (!tenant.vapiAssistantId) {
    throw new ServiceError("validation", "לדמו אין assistant משלו. הפרומפט נערך על ה-assistant של הלקוח אחרי ההמרה.");
  }
  const assistant = await vapi.getAssistant(tenant.vapiAssistantId);
  return { prompt: promptFromModel(assistant.model), model: assistant.model?.model ?? null };
}

/**
 * עדכון הפרומפט: מחליף רק את התוכן של הודעת ה-system, ושולח את ה-model בשלמותו,
 * כך ששאר ההגדרות (מודל, טמפרטורה, כלים) לא נפגעות.
 */
export async function updateAssistantPrompt(ref: string, prompt: string) {
  const tenant = await findTenant(ref);
  if (!tenant.vapiAssistantId) {
    throw new ServiceError("validation", "לדמו אין assistant משלו, ולכן אין לו פרומפט לעריכה.");
  }
  const trimmed = prompt.trim();
  if (!trimmed) throw new ServiceError("validation", "הפרומפט ריק. אם רוצים למחוק אותו, עדיף לעשות את זה ב-Vapi.");
  if (trimmed.length > PROMPT_MAX) {
    throw new ServiceError("validation", `הפרומפט ארוך מדי (${trimmed.length} תווים). המגבלה: ${PROMPT_MAX}.`);
  }

  const assistant = await vapi.getAssistant(tenant.vapiAssistantId);
  if (!assistant.model) {
    throw new ServiceError("validation", "ל-assistant הזה אין model מוגדר ב-Vapi, אז אין איפה לשמור פרומפט.");
  }
  const before = promptFromModel(assistant.model);
  await vapi.patchAssistant(tenant.vapiAssistantId, { model: modelWithPrompt(assistant.model, trimmed) });
  await getDb().insert(auditLog).values({
    tenantId: tenant.id,
    actorType: "admin",
    action: "prompt.update",
    before: { prompt: before },
    after: { prompt: trimmed },
  });
}

export interface TenantOverview {
  tenant: Tenant;
  usage: PlanUsage | null;
  /** בדמו: כמה שניות ניסיון כבר נוצלו */
  demoUsedSeconds: number | null;
  activeLinks: number;
}

/** כל הלקוחות והדמואים, עם הניצול הנוכחי, לרשימה בפאנל הניהול */
export async function listTenantsOverview(): Promise<TenantOverview[]> {
  const db = getDb();
  const rows = await db
    .select({
      tenant: tenants,
      activeLinks: sql<number>`(select count(*)::int from ${accessLinks} where ${accessLinks.tenantId} = ${tenants.id} and ${accessLinks.revokedAt} is null)`,
    })
    .from(tenants)
    .orderBy(desc(tenants.createdAt));

  // שתי שאילתות לכל הלקוחות יחד, במקום שתיים לכל לקוח
  const all = rows.map((r) => r.tenant);
  const demoIds = all.filter((t) => t.type === "demo").map((t) => t.id);
  const [usage, demoSeconds] = await Promise.all([planUsageMany(all), testSecondsByTenant(db, demoIds)]);

  return rows.map((row) => ({
    tenant: row.tenant,
    activeLinks: row.activeLinks,
    usage: usage.get(row.tenant.id) ?? null,
    demoUsedSeconds: row.tenant.type === "demo" ? (demoSeconds.get(row.tenant.id) ?? 0) : null,
  }));
}

/** קישור כפי שפאנל הניהול מציג אותו. url הוא null כשאי אפשר לשחזר אותו. */
export interface AdminLink extends Pick<AccessLink, "id" | "label" | "createdAt" | "revokedAt" | "lastUsedAt"> {
  url: string | null;
}

export interface TenantDetail extends TenantOverview {
  links: AdminLink[];
  settings: BotSettings | null;
  recentCalls: Pick<Call, "id" | "type" | "status" | "startedAt" | "durationSeconds" | "endedReason" | "customerNumber">[];
}

/** כל מה שעמוד הלקוח בפאנל הניהול מציג */
export async function tenantDetail(ref: string): Promise<TenantDetail> {
  const tenant = await findTenant(ref);
  // מרעננים מ-Vapi לפני ההצגה, כדי שהדקות יהיו עדכניות. best effort: בלי Vapi מציגים את מה שיש ב-DB.
  if (isVapiConfigured()) {
    const since = tenant.planStartedAt
      ? currentCycle(tenant.planStartedAt).from
      : new Date(Date.now() - 24 * 60 * 60 * 1000);
    await Promise.all([
      tenant.vapiAssistantId ? syncTenantCallsIfStale(tenant, since).catch(() => null) : null,
      refreshOpenTestCalls(tenant.id).catch(() => 0),
    ]);
  }

  const db = getDb();
  const [links, versions, recentCalls, usage, demoSeconds] = await Promise.all([
    db
      .select({
        id: accessLinks.id,
        label: accessLinks.label,
        createdAt: accessLinks.createdAt,
        revokedAt: accessLinks.revokedAt,
        lastUsedAt: accessLinks.lastUsedAt,
        tokenEncrypted: accessLinks.tokenEncrypted,
      })
      .from(accessLinks)
      .where(eq(accessLinks.tenantId, tenant.id))
      .orderBy(desc(accessLinks.createdAt)),
    tenant.currentVersionId
      ? db.select().from(botVersions).where(eq(botVersions.id, tenant.currentVersionId))
      : Promise.resolve([]),
    db
      .select({
        id: calls.id,
        type: calls.type,
        status: calls.status,
        startedAt: calls.startedAt,
        durationSeconds: calls.durationSeconds,
        endedReason: calls.endedReason,
        customerNumber: calls.customerNumber,
      })
      .from(calls)
      .where(eq(calls.tenantId, tenant.id))
      .orderBy(desc(calls.createdAt))
      .limit(10),
    planUsage(tenant),
    tenant.type === "demo" ? demoUsedSeconds(tenant.id) : Promise.resolve(null),
  ]);

  return {
    tenant,
    links: links.map(({ tokenEncrypted, ...link }) => {
      const key = decryptAccessKey(tokenEncrypted);
      return { ...link, url: key ? linkUrl(key) : null };
    }),
    settings: versions[0]?.settings ?? null,
    recentCalls,
    usage,
    demoUsedSeconds: demoSeconds,
    activeLinks: links.filter((l) => !l.revokedAt).length,
  };
}

/** משעה או מחזיר לפעילות. לקוח מושהה לא יכול להיכנס לדף שלו. */
export async function setTenantStatus(ref: string, status: "active" | "suspended") {
  const tenant = await findTenant(ref);
  const db = getDb();
  const [updated] = await db.update(tenants).set({ status }).where(eq(tenants.id, tenant.id)).returning();
  await db.insert(auditLog).values({
    tenantId: tenant.id,
    actorType: "admin",
    action: status === "suspended" ? "tenant.suspend" : "tenant.activate",
  });
  return updated;
}
