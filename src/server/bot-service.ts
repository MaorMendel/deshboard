// הפעולות של מסך העריכה: טעינה, עדכון הבוט ושיחת ניסיון.

import { eq, sql } from "drizzle-orm";
import type { BotPageData, BotSettings, PlanInfo, TestCallResult, UpdateResult } from "@/lib/types";
import {
  CUSTOMER_PROMPT_MAX,
  customerPromptLimit,
  hasErrors,
  normalizeSettings,
  validateSettings,
} from "@/lib/validation";
import { getDb } from "@/db";
import { auditLog, botVersions, calls, tenants, type Tenant, type VoiceRow } from "@/db/schema";
import { maskPhone, requireAccess, type Access, type RequestMeta } from "./access";
import { demoUsedSeconds, refreshOpenTestCalls, syncTenantCallsIfStale } from "./call-sync";
import { config } from "./config";
import { isUniqueViolation, ServiceError } from "./errors";
import { planUsage } from "./plan";
import {
  buildVoice,
  firstMessageFields,
  modelWithPrompt,
  promptFromModel,
  settingsFromAssistant,
  toAssistantFields,
} from "./vapi";
import { isVapiConfigured, vapi, VapiError, type AssistantFields } from "./vapi-client";
import { findCatalogVoice, selectableVoices, toPublicVoice } from "./voice-catalog";

/** פחות מזה לא שווה להתחיל שיחת דמו */
const MIN_DEMO_CALL_SECONDS = 15;

/** הדפדפן שולח JSON חופשי. מוודאים שזו באמת צורה של BotSettings לפני כל דבר אחר. */
export function parseSettings(input: unknown): BotSettings {
  const o = input as Record<string, unknown> | null;
  if (
    !o ||
    typeof o.voiceId !== "string" ||
    typeof o.firstSpeaker !== "string" ||
    typeof o.openingMessage !== "string" ||
    typeof o.closingMessage !== "string"
  ) {
    throw new ServiceError("validation", "הבקשה לא תקינה.");
  }
  return {
    voiceId: o.voiceId,
    firstSpeaker: o.firstSpeaker as BotSettings["firstSpeaker"],
    openingMessage: o.openingMessage,
    closingMessage: o.closingMessage,
    prompt: typeof o.prompt === "string" ? o.prompt : "",
  };
}

async function currentVersion(tenant: Tenant) {
  if (!tenant.currentVersionId) return null;
  const db = getDb();
  const [v] = await db.select().from(botVersions).where(eq(botVersions.id, tenant.currentVersionId));
  return v ?? null;
}

function defaultSettings(voices: VoiceRow[], tenantName: string): BotSettings {
  return {
    voiceId: voices[0]?.id ?? "",
    firstSpeaker: "bot",
    openingMessage: `שלום, הגעתם ל${tenantName}. איך אפשר לעזור?`,
    closingMessage: "",
    prompt: "",
  };
}

async function planInfo(tenant: Tenant): Promise<PlanInfo> {
  if (tenant.type !== "demo") {
    const usage = await planUsage(tenant);
    return {
      type: "customer",
      usage: usage
        ? {
            usedMinutes: usage.usedMinutes,
            limitMinutes: usage.limitMinutes,
            renewsAt: usage.cycleEnd.toISOString(),
          }
        : null,
    };
  }
  const limit = tenant.demoSecondsLimit ?? 0;
  const used = await demoUsedSeconds(tenant.id);
  return {
    type: "demo",
    limitSeconds: limit,
    remainingSeconds: Math.max(0, limit - used),
    expiresAt: (tenant.demoExpiresAt ?? new Date()).toISOString(),
  };
}

/** הנתונים של מסך העריכה */
export async function getBotPageData({ tenant }: Access): Promise<BotPageData> {
  const vapiReady = isVapiConfigured();
  const isCustomer = tenant.type === "customer";

  // סבב ראשון, במקביל: מה שצריך לרוץ לפני חישוב הדקות, והקריאות ל-Vapi שלא תלויות בו.
  // כל קריאה ל-Vapi היא best effort: אם הוא לא זמין, מציגים את מה שיש ב-DB.
  const [version, assistant] = await Promise.all([
    currentVersion(tenant),
    // ההנחיות החיות נמצאות ב-Vapi (גם אדמין יכול לערוך אותן שם), ולכן נקראות משם ולא מה-DB.
    // בלי זיכרון: מה שמוצג כאן חוזר אלינו בעדכון הבא, ותשובה ישנה תדרוס את מה שנשמר בינתיים.
    isCustomer && tenant.vapiAssistantId && vapiReady
      ? vapi.getAssistant(tenant.vapiAssistantId).catch(() => null)
      : null,
    // שיחת ניסיון שהסתיימה ב-Vapi מתעדכנת כאן, כדי שהיתרה בדמו תהיה מדויקת
    vapiReady ? refreshOpenTestCalls(tenant.id).catch(() => 0) : 0,
    // אצל לקוח עם חבילה: מושכים מ-Vapi את השיחות של היממה האחרונה, כדי שמונה הדקות יהיה עדכני גם בלי cron
    vapiReady && isCustomer && tenant.planMinutes
      ? syncTenantCallsIfStale(tenant, new Date(Date.now() - 24 * 60 * 60 * 1000)).catch(() => null)
      : null,
  ]);

  // אצל לקוח משלם ה-assistant ב-Vapi הוא מקור האמת: גם מפתח יכול לשנות אותו שם,
  // והמסך צריך להראות את מה שהבוט באמת עובד איתו עכשיו. כשאין Vapi, מציגים את מה שנשמר אצלנו.
  // הקול הוא היחיד שצריך תרגום: מזהה הספק -> הקול בקטלוג שלנו.
  const liveVoice = assistant ? await findCatalogVoice(assistant.voice) : null;
  const savedSettings = version?.settings ? { prompt: "", ...version.settings } : null;
  const voiceId = liveVoice?.id ?? savedSettings?.voiceId;

  const [voiceRows, plan] = await Promise.all([selectableVoices(voiceId), planInfo(tenant)]);
  const settings = assistant
    ? settingsFromAssistant(assistant, voiceId ?? voiceRows[0]?.id ?? "")
    : (savedSettings ?? defaultSettings(voiceRows, tenant.name));

  return {
    business: { name: tenant.name, botPhoneDisplay: tenant.botPhoneDisplay },
    settings,
    voices: voiceRows.map(toPublicVoice),
    lastUpdatedAt: version?.createdAt.toISOString() ?? null,
    plan,
    testPhoneMasked: tenant.verifiedPhone ? maskPhone(tenant.verifiedPhone) : null,
    promptMax: customerPromptLimit((settings.prompt ?? "").trim().length),
  };
}

/**
 * כמה תווים מותר בהנחיות שהלקוח שולח. נבדק רק כשהן ארוכות מהמגבלה הרגילה, כי רק אז צריך לדעת
 * כמה ארוכות ההנחיות שכבר יש: אצל לקוח משלם, מה שב-Vapi עכשיו (אדמין יכול לקצר או להאריך שם);
 * בדמו, מה שנשמר אצלנו.
 */
async function promptLimitFor(tenant: Tenant, saved: BotSettings | null): Promise<number> {
  let current = (saved?.prompt ?? "").trim().length;
  if (tenant.type === "customer" && tenant.vapiAssistantId && isVapiConfigured()) {
    const assistant = await vapi.getAssistant(tenant.vapiAssistantId).catch(() => null);
    if (assistant) current = promptFromModel(assistant.model).trim().length;
  }
  return customerPromptLimit(current);
}

async function validateForTenant(tenant: Tenant, input: BotSettings): Promise<{ settings: BotSettings; voice: VoiceRow }> {
  const version = await currentVersion(tenant);
  const allowed = await selectableVoices(version?.settings.voiceId);
  const settings = normalizeSettings(input);
  const promptMax =
    (settings.prompt ?? "").length > CUSTOMER_PROMPT_MAX
      ? await promptLimitFor(tenant, version?.settings ?? null)
      : CUSTOMER_PROMPT_MAX;
  const errors = validateSettings(
    settings,
    allowed.map((v) => v.id),
    promptMax,
  );
  if (hasErrors(errors)) {
    throw new ServiceError("validation", "יש שדות שצריך לתקן לפני שממשיכים.", errors);
  }
  return { settings, voice: allowed.find((v) => v.id === settings.voiceId)! };
}

function vapiFailure(err: unknown, message: string): never {
  if (err instanceof VapiError) {
    console.error("Vapi error:", err.status, err.message);
    throw new ServiceError("vapi_error", message);
  }
  throw err;
}

/** "עדכן את הבוט": גרסה חדשה ב-DB, ואצל לקוח משלם גם עדכון ה-assistant ב-Vapi */
export async function updateBot(
  key: string,
  input: BotSettings,
  meta: RequestMeta,
  /**
   * ההגדרות כפי שהמסך טען אותן. ל-Vapi נכתבים רק השדות שבאמת השתנו מאז,
   * כך שמסך שהיה פתוח מזמן לא דורס שינוי שנעשה בינתיים ב-Vapi או בפאנל הניהול.
   * undefined (פקודה, או דפדפן ישן) = נכתבים כל השדות, כמו קודם.
   */
  baseline?: BotSettings,
): Promise<UpdateResult> {
  const { tenant, linkId } = await requireAccess(key);
  const { settings, voice } = await validateForTenant(tenant, input);
  const previous = (await currentVersion(tenant))?.settings ?? null;

  const isCustomer = tenant.type === "customer";
  if (isCustomer && !tenant.vapiAssistantId) {
    throw new ServiceError("not_configured", "הבוט עוד לא מחובר. כדאי לפנות אלינו.");
  }
  if (isCustomer && !isVapiConfigured()) {
    throw new ServiceError("not_configured", "החיבור ל-Vapi לא מוגדר בשרת.");
  }

  const db = getDb();
  const created = await db.transaction(async (tx) => {
    const [{ next }] = await tx
      .select({ next: sql<number>`coalesce(max(${botVersions.version}), 0) + 1` })
      .from(botVersions)
      .where(eq(botVersions.tenantId, tenant.id));

    let payload: Record<string, unknown> | null = null;
    if (isCustomer) {
      try {
        const prompt = settings.prompt ?? "";
        const base = baseline ? normalizeSettings(baseline) : null;
        const voiceChanged = !base || settings.voiceId !== base.voiceId;
        const firstMessageChanged =
          !base || settings.openingMessage !== base.openingMessage || settings.firstSpeaker !== base.firstSpeaker;
        const closingChanged = !base || settings.closingMessage !== base.closingMessage;
        // הנחיות ריקות לא מוחקות את מה שיש ב-Vapi
        const promptChanged = prompt !== "" && (!base || prompt !== (base.prompt ?? ""));

        // ה-assistant נחוץ כשצריך להשלים כיוונוני קול, וכשעורכים את ההנחיות (כדי לא לדרוס את שאר ה-model).
        // כאן קוראים תמיד טרי, בלי זיכרון: מה שנקרא נשלח בחזרה, ותשובה ישנה תדרוס שינוי שנעשה ב-Vapi.
        const needsAssistant = (voiceChanged && !voice.providerConfig) || promptChanged;
        const assistant = needsAssistant ? await vapi.getAssistant(tenant.vapiAssistantId!) : null;

        const fields: AssistantFields = {};
        if (voiceChanged) fields.voice = buildVoice(voice, assistant?.voice);
        if (firstMessageChanged) Object.assign(fields, firstMessageFields(settings));
        if (closingChanged) fields.endCallMessage = settings.closingMessage;
        if (promptChanged && assistant?.model) fields.model = modelWithPrompt(assistant.model, prompt);

        if (Object.keys(fields).length > 0) {
          await vapi.updateAssistant(tenant.vapiAssistantId!, fields);
          payload = fields as Record<string, unknown>;
        }
      } catch (err) {
        vapiFailure(err, "לא הצלחנו לעדכן את הבוט. שום דבר לא השתנה, אפשר לנסות שוב בעוד רגע.");
      }
    }

    const [version] = await tx
      .insert(botVersions)
      .values({
        tenantId: tenant.id,
        version: Number(next),
        settings,
        vapiPayload: payload,
        createdByType: "link",
        createdByLinkId: linkId,
      })
      .returning();
    await tx.update(tenants).set({ currentVersionId: version.id }).where(eq(tenants.id, tenant.id));
    await tx.insert(auditLog).values({
      tenantId: tenant.id,
      actorType: "link",
      actorLinkId: linkId,
      action: "bot.update",
      before: previous,
      after: settings,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return version;
  });

  return { settings, lastUpdatedAt: created.createdAt.toISOString() };
}

/** "נסה את הבוט": מתקשר לטלפון המאומת עם ההגדרות שעל המסך, בלי לשנות את הבוט החי */
export async function startTestCall(key: string, input: BotSettings, meta: RequestMeta): Promise<TestCallResult> {
  const { tenant, linkId } = await requireAccess(key);
  const { settings, voice } = await validateForTenant(tenant, input);

  if (!tenant.verifiedPhone) {
    throw new ServiceError("not_configured", "עוד לא הוגדר מספר טלפון לשיחות ניסיון. כדאי לפנות אלינו.");
  }
  const isDemo = tenant.type === "demo";
  const assistantId = isDemo ? config.vapi.demoAssistantId() : tenant.vapiAssistantId;
  const phoneNumberId = isDemo
    ? config.vapi.testPhoneNumberId()
    : tenant.vapiPhoneNumberId || config.vapi.testPhoneNumberId();
  if (!isVapiConfigured() || !assistantId || !phoneNumberId) {
    throw new ServiceError("not_configured", "שיחות ניסיון עוד לא מוגדרות. כדאי לפנות אלינו.");
  }

  // שיחה קודמת שכבר הסתיימה ב-Vapi לא צריכה לחסום את הבאה
  await refreshOpenTestCalls(tenant.id);

  let demoRemaining: number | null = null;
  if (isDemo) {
    demoRemaining = Math.max(0, (tenant.demoSecondsLimit ?? 0) - (await demoUsedSeconds(tenant.id)));
    if (demoRemaining < MIN_DEMO_CALL_SECONDS) {
      throw new ServiceError("demo_ended", "נגמרו דקות הדמו. כדאי לפנות אלינו כדי להמשיך.");
    }
  }

  const db = getDb();
  let rowId: string;
  try {
    const [row] = await db
      .insert(calls)
      .values({
        tenantId: tenant.id,
        type: "test",
        status: "queued",
        vapiAssistantId: assistantId,
        customerNumber: tenant.verifiedPhone,
        versionId: tenant.currentVersionId,
        testSettings: settings,
      })
      .returning({ id: calls.id });
    rowId = row.id;
  } catch (err) {
    if (isUniqueViolation(err, "calls_one_active_test")) {
      throw new ServiceError("busy", "יש כבר שיחת ניסיון פעילה. אפשר לנסות שוב כשהיא תסתיים.");
    }
    throw err;
  }

  try {
    // ה-assistant נחוץ כשצריך להשלים כיוונוני קול, וכשיש הנחיות על המסך
    const prompt = (settings.prompt ?? "").trim();
    const assistant = !voice.providerConfig || prompt ? await vapi.getAssistant(assistantId) : null;
    const overrides = toAssistantFields(settings, buildVoice(voice, assistant?.voice));
    if (demoRemaining !== null) overrides.maxDurationSeconds = demoRemaining;
    // ההנחיות שעל המסך חלות על שיחת הניסיון בלבד, דרך override של ה-model
    if (prompt && assistant?.model) overrides.model = modelWithPrompt(assistant.model, prompt);
    const call = await vapi.createCall({
      assistantId,
      assistantOverrides: overrides,
      phoneNumberId,
      customer: { number: tenant.verifiedPhone },
      name: `שיחת ניסיון - ${tenant.name}`.slice(0, 40),
    });
    await db.update(calls).set({ vapiCallId: call.id }).where(eq(calls.id, rowId));
  } catch (err) {
    await db
      .update(calls)
      .set({ status: "failed", endedReason: `start-failed: ${(err as Error).message}`.slice(0, 500) })
      .where(eq(calls.id, rowId));
    vapiFailure(err, "לא הצלחנו להתחיל את שיחת הניסיון. אפשר לנסות שוב בעוד רגע.");
  }

  await db.insert(auditLog).values({
    tenantId: tenant.id,
    actorType: "link",
    actorLinkId: linkId,
    action: "test_call.start",
    after: settings,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return { calledNumberMasked: maskPhone(tenant.verifiedPhone), demoRemainingSeconds: demoRemaining };
}
