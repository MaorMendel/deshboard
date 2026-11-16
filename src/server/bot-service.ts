// הפעולות של מסך העריכה: טעינה, עדכון הבוט ושיחת ניסיון.

import { and, eq, sql } from "drizzle-orm";
import type { BotPageData, BotSettings, CustomerVersion, PlanInfo, TestCallResult, UpdateResult } from "@/lib/types";
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
import {
  adjustVoice,
  backgroundFromAssistant,
  featuresForTenant,
  presetsForTenant,
  stepsFromVoice,
  styleFromAssistant,
  supportsVolume,
  timingFields,
  voiceAdjustmentsChanged,
} from "./conversation-style";
import { isBackgroundSound, isResponseStyle, isStep, NO_FEATURES, withoutClosed } from "@/lib/conversation-style";
import { customerVersions } from "./versions";

/** פחות מזה לא שווה להתחיל שיחת דמו */
const MIN_DEMO_CALL_SECONDS = 15;

/**
 * שדה אופציונלי של סגנון השיחה: חסר = undefined (לא נוגעים), קיים = חייב להיות אחת האפשרויות.
 * מספרים חופשיים לא מתקבלים בכלל: הלקוח שולח בחירה, והשרת קובע מה נשלח ל-Vapi.
 */
function choice<T>(value: unknown, guard: (v: unknown) => v is T, allowNull = false): T | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && allowNull) return null;
  if (!guard(value)) throw new ServiceError("validation", "הבקשה לא תקינה.");
  return value;
}

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
    ...defined({
      responseStyle: choice(o.responseStyle, isResponseStyle, true),
      speechRate: choice(o.speechRate, isStep) ?? undefined,
      volume: choice(o.volume, isStep) ?? undefined,
      backgroundSound: choice(o.backgroundSound, isBackgroundSound) ?? undefined,
    }),
  };
}

function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
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

  const [voiceRows, plan, presets, features] = await Promise.all([
    selectableVoices(voiceId),
    planInfo(tenant),
    assistant ? presetsForTenant(tenant.id).catch(() => null) : null,
    featuresForTenant(tenant.id).catch(() => ({ ...NO_FEATURES })),
  ]);
  const allSettings: BotSettings = assistant
    ? {
        ...settingsFromAssistant(assistant, voiceId ?? voiceRows[0]?.id ?? ""),
        // סגנון השיחה, כמו שהוא באמת מוגדר ב-Vapi. קצב מענה שלא תואם לאף אחד מהשניים:
        // מה שהלקוח בחר בפעם האחרונה, ואם לא בחר, בלי בחירה.
        responseStyle:
          (presets ? styleFromAssistant(assistant, presets.effective) : null) ?? savedSettings?.responseStyle ?? null,
        ...stepsFromVoice(assistant.voice, liveVoice, savedSettings),
        backgroundSound: backgroundFromAssistant(assistant),
      }
    : {
        responseStyle: null,
        speechRate: 0,
        volume: 0,
        backgroundSound: "office",
        ...(savedSettings ?? defaultSettings(voiceRows, tenant.name)),
      };
  // מה שסגור ללקוח לא מגיע לדף בכלל
  const settings = withoutClosed(allSettings, features);

  return {
    business: { name: tenant.name, botPhoneDisplay: tenant.botPhoneDisplay },
    settings,
    voices: voiceRows.map(toPublicVoice),
    lastUpdatedAt: version?.createdAt.toISOString() ?? null,
    plan,
    testPhoneMasked: tenant.verifiedPhone ? maskPhone(tenant.verifiedPhone) : null,
    promptMax: customerPromptLimit((settings.prompt ?? "").trim().length),
    features,
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
  const voice = allowed.find((v) => v.id === settings.voiceId)!;
  // עוצמה לקול שלא תומך בה לא משנה כלום. שומרים 0, כדי שההיסטוריה לא תראה שינוי שלא קרה.
  if (settings.volume && !supportsVolume(voice.provider, voice.providerConfig as Record<string, unknown> | null)) {
    settings.volume = 0;
  }
  return { settings, voice };
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
  /** הלקוח החזיר למסך גרסה קודמת ושמר אותה כמו שהיא. רק לתיעוד בהיסטוריה ("חזרה לגרסה 3"). */
  restoredFromVersion?: number,
): Promise<UpdateResult> {
  const { tenant, linkId } = await requireAccess(key);
  const validated = await validateForTenant(tenant, input);
  let settings = validated.settings;
  const voice = validated.voice;
  const previous = (await currentVersion(tenant))?.settings ?? null;

  const isCustomer = tenant.type === "customer";
  if (isCustomer && !tenant.vapiAssistantId) {
    throw new ServiceError("not_configured", "הבוט עוד לא מחובר. כדאי לפנות אלינו.");
  }
  if (isCustomer && !isVapiConfigured()) {
    throw new ServiceError("not_configured", "החיבור ל-Vapi לא מוגדר בשרת.");
  }

  // נקרא לפני הטרנזקציה: שאילתה מחוץ לטרנזקציה פתוחה תופסת עוד חיבור (ובחיבור יחיד, נתקעת)
  // מה שהאדמין לא פתח ללקוח: השרת מתעלם ממנו, גם אם נשלח. לא מגיע ל-Vapi ולא נשמר בגרסה.
  const features = await featuresForTenant(tenant.id);
  settings = withoutClosed(settings, features);
  if (baseline) baseline = withoutClosed(baseline, features);
  const presets = settings.responseStyle ? (await presetsForTenant(tenant.id)).effective : null;

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
        // סגנון השיחה: רק מה שהלקוח באמת בחר ושינה. בלי בחירה (null) לא נוגעים במה שמוגדר ב-Vapi.
        const adjustChanged = voiceAdjustmentsChanged(settings, base);
        const style = settings.responseStyle ?? null;
        const styleChanged = style !== null && (!base || style !== (base.responseStyle ?? null));
        const background = settings.backgroundSound;
        const backgroundChanged = background !== undefined && (!base || background !== (base.backgroundSound ?? "office"));

        // ה-assistant נחוץ כשצריך להשלים כיוונוני קול, כשעורכים את ההנחיות (כדי לא לדרוס את שאר ה-model),
        // וכשמשנים קצב מענה (כדי לא לדרוס את שאר הגדרות התמלול ו-startSpeakingPlan).
        // כאן קוראים תמיד טרי, בלי זיכרון: מה שנקרא נשלח בחזרה, ותשובה ישנה תדרוס שינוי שנעשה ב-Vapi.
        const needsAssistant = ((voiceChanged || adjustChanged) && !voice.providerConfig) || promptChanged || styleChanged;
        const assistant = needsAssistant ? await vapi.getAssistant(tenant.vapiAssistantId!) : null;

        const fields: AssistantFields = {};
        if (voiceChanged || adjustChanged) {
          fields.voice = adjustVoice(buildVoice(voice, assistant?.voice), settings.speechRate, settings.volume);
        }
        if (styleChanged && presets) {
          const timing = timingFields(assistant, presets[style]);
          fields.startSpeakingPlan = timing.startSpeakingPlan;
          if (timing.transcriber) fields.transcriber = timing.transcriber;
        }
        if (backgroundChanged) fields.backgroundSound = background;
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
    if (restoredFromVersion) {
      // רק מספר של גרסה שבאמת קיימת אצל הלקוח הזה
      const [source] = await tx
        .select({ id: botVersions.id })
        .from(botVersions)
        .where(and(eq(botVersions.tenantId, tenant.id), eq(botVersions.version, restoredFromVersion)));
      if (source && source.id !== version.id) {
        await tx.insert(auditLog).values({
          tenantId: tenant.id,
          actorType: "link",
          actorLinkId: linkId,
          action: "bot.restore",
          after: { versionId: version.id, restoredFromVersion, settings },
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
      }
    }
    return version;
  });

  return { settings, lastUpdatedAt: created.createdAt.toISOString() };
}

/** "נסה את הבוט": מתקשר לטלפון המאומת עם ההגדרות שעל המסך, בלי לשנות את הבוט החי */
export async function startTestCall(key: string, input: BotSettings, meta: RequestMeta): Promise<TestCallResult> {
  const { tenant, linkId } = await requireAccess(key);
  const validated = await validateForTenant(tenant, input);
  const voice = validated.voice;
  // מה שסגור ללקוח לא חל גם על שיחת הניסיון
  const settings = withoutClosed(validated.settings, await featuresForTenant(tenant.id));

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
    // ה-assistant נחוץ כשצריך להשלים כיוונוני קול, כשיש הנחיות על המסך, וכשנבחר קצב מענה
    const prompt = (settings.prompt ?? "").trim();
    const style = settings.responseStyle ?? null;
    const assistant = !voice.providerConfig || prompt || style ? await vapi.getAssistant(assistantId) : null;
    const overrides = toAssistantFields(
      settings,
      adjustVoice(buildVoice(voice, assistant?.voice), settings.speechRate, settings.volume),
    );
    // סגנון השיחה שעל המסך חל על שיחת הניסיון, בלי לשנות את הבוט
    if (style) {
      const timing = timingFields(assistant, (await presetsForTenant(tenant.id)).effective[style]);
      overrides.startSpeakingPlan = timing.startSpeakingPlan;
      if (timing.transcriber) overrides.transcriber = timing.transcriber;
    }
    if (settings.backgroundSound) overrides.backgroundSound = settings.backgroundSound;
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

/** הגרסאות הקודמות, לדף של הלקוח */
export async function versionHistory(key: string): Promise<CustomerVersion[]> {
  const { tenant } = await requireAccess(key);
  return customerVersions(tenant);
}
