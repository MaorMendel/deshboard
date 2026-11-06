// ניהול קטלוג הקולות מהפאנל: רשימה, עריכה, הוספה, דוגמאות שמע, והחלת שינוי על ה-assistants.
//
// אבטחה: הלקוח בוחר רק slug מהקטלוג (למשל "noam"). הספק, ה-ID אצל הספק, המודל והכיוונונים
// נשמרים כאן, ב-provider_config, ונבנים לבקשה ל-Vapi רק בשרת (buildVoice). שום שדה שהדפדפן שולח
// לא מגיע ל-Vapi כקול או כמודל. לכן כל מה שבקובץ הזה נקרא רק מ-actions של אדמין.

import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, botVersions, tenants, voices, type VoiceRow } from "@/db/schema";
import { isVoiceProvider, PROVIDERS, type VoiceProvider } from "@/lib/voice-providers";
import { ServiceError } from "./errors";
import { buildVoice } from "./vapi";
import { isVapiConfigured, vapi, VapiError } from "./vapi-client";
import { slugFor } from "./voice-catalog";
import { checkMp3, generateVoiceSamples, saveVoiceSample, SAMPLE_PROVIDERS } from "./voice-samples";

export interface AdminVoice {
  id: string;
  name: string;
  gender: "female" | "male";
  description: string;
  provider: string;
  providerVoiceId: string;
  model: string | null;
  speed: number | null;
  stability: number | null;
  tier: "standard" | "premium";
  isActive: boolean;
  sortOrder: number;
  sampleUrl: string | null;
  hasSample: boolean;
  /** כמה לקוחות ודמואים בחרו בקול הזה בגרסה הנוכחית שלהם */
  usedBy: number;
  /** האם אפשר ליצור לו דוגמה אוטומטית */
  canGenerate: boolean;
}

type Cfg = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function speedOf(provider: string, cfg: Cfg): number | null {
  if (provider === "cartesia") return num((cfg.generationConfig as Cfg | undefined)?.speed);
  return num(cfg.speed);
}

export async function listVoicesAdmin(): Promise<AdminVoice[]> {
  const db = getDb();
  const [rows, usage] = await Promise.all([
    db
      .select({
        id: voices.id,
        name: voices.name,
        gender: voices.gender,
        description: voices.description,
        provider: voices.provider,
        providerVoiceId: voices.providerVoiceId,
        providerConfig: voices.providerConfig,
        tier: voices.tier,
        isActive: voices.isActive,
        sortOrder: voices.sortOrder,
        sampleUrl: voices.sampleUrl,
        // את הקובץ עצמו לא מושכים לרשימה, רק אם הוא קיים
        hasSample: sql<boolean>`${voices.sampleAudio} is not null`,
      })
      .from(voices)
      .orderBy(asc(voices.sortOrder), asc(voices.name)),
    db
      .select({ voiceId: sql<string>`${botVersions.settings}->>'voiceId'`, n: sql<number>`count(*)::int` })
      .from(tenants)
      .innerJoin(botVersions, eq(tenants.currentVersionId, botVersions.id))
      .groupBy(sql`${botVersions.settings}->>'voiceId'`),
  ]);
  const usedBy = new Map(usage.map((u) => [u.voiceId, Number(u.n)]));

  return rows.map(({ providerConfig, ...v }) => {
    const cfg = (providerConfig ?? {}) as Cfg;
    return {
      ...v,
      hasSample: Boolean(v.hasSample),
      model: typeof cfg.model === "string" ? cfg.model : null,
      speed: speedOf(v.provider, cfg),
      stability: num(cfg.stability),
      usedBy: usedBy.get(v.id) ?? 0,
      canGenerate: (SAMPLE_PROVIDERS as readonly string[]).includes(v.provider) && v.providerVoiceId !== "REPLACE_ME",
    };
  });
}

// ---------- ולידציה של כיוונוני הקול ----------

export interface VoiceTuning {
  /** מחרוזת ריקה = להסיר ולתת ל-Vapi לבחור ברירת מחדל */
  model?: string;
  /** null = להסיר */
  speed?: number | null;
  stability?: number | null;
}

function checkTuning(provider: VoiceProvider, tuning: VoiceTuning) {
  const spec = PROVIDERS[provider];
  if (tuning.model && !spec.models.includes(tuning.model)) {
    throw new ServiceError("validation", `המודל ${tuning.model} לא נתמך ב-Vapi עבור ${spec.label}.`);
  }
  if (tuning.speed != null) {
    const [min, max] = spec.speed;
    if (!(tuning.speed >= min && tuning.speed <= max)) {
      throw new ServiceError("validation", `מהירות צריכה להיות בין ${min} ל-${max}.`);
    }
  }
  if (tuning.stability != null) {
    if (!spec.stability) throw new ServiceError("validation", `ל-${spec.label} אין stability.`);
    if (!(tuning.stability >= 0 && tuning.stability <= 1)) {
      throw new ServiceError("validation", "stability צריך להיות בין 0 ל-1.");
    }
  }
}

/** מחיל כיוונונים על provider_config. שדה שלא נשלח (undefined) נשאר כמו שהוא. */
function applyTuning(provider: VoiceProvider, base: Cfg, tuning: VoiceTuning): Cfg {
  const cfg: Cfg = { ...base };
  if (tuning.model !== undefined) {
    if (tuning.model) cfg.model = tuning.model;
    else delete cfg.model;
  }
  if (tuning.speed !== undefined) {
    if (provider === "cartesia") {
      const gen: Cfg = { ...((cfg.generationConfig as Cfg | undefined) ?? {}) };
      if (tuning.speed === null) delete gen.speed;
      else gen.speed = tuning.speed;
      if (Object.keys(gen).length) cfg.generationConfig = gen;
      else delete cfg.generationConfig;
    } else if (tuning.speed === null) delete cfg.speed;
    else cfg.speed = tuning.speed;
  }
  if (tuning.stability !== undefined) {
    if (tuning.stability === null) delete cfg.stability;
    else cfg.stability = tuning.stability;
  }
  return cfg;
}

// ---------- עריכה ----------

export interface VoiceDetailsInput extends VoiceTuning {
  name: string;
  gender: string;
  description: string;
  tier: string;
  sortOrder: number;
  isActive: boolean;
}

function checkDetails(input: Pick<VoiceDetailsInput, "name" | "gender" | "tier" | "description">) {
  if (!input.name.trim()) throw new ServiceError("validation", "צריך שם לקול.");
  if (input.name.trim().length > 40) throw new ServiceError("validation", "השם ארוך מדי (עד 40 תווים).");
  if (input.description.trim().length > 120) throw new ServiceError("validation", "התיאור ארוך מדי (עד 120 תווים).");
  if (input.gender !== "female" && input.gender !== "male") throw new ServiceError("validation", "צריך לבחור מגדר.");
  if (input.tier !== "standard" && input.tier !== "premium") throw new ServiceError("validation", "רמה לא תקינה.");
}

/** שורת קול ליומן הפעולות, בלי קובץ השמע */
function forLog({ sampleAudio, ...rest }: VoiceRow) {
  return { ...rest, hasSample: sampleAudio != null };
}

async function getVoice(id: string): Promise<VoiceRow> {
  const [row] = await getDb().select().from(voices).where(eq(voices.id, id));
  if (!row) throw new ServiceError("validation", "הקול לא נמצא.");
  return row;
}

export async function updateVoice(
  id: string,
  input: VoiceDetailsInput,
): Promise<{ voice: VoiceRow; tuningChanged: boolean }> {
  checkDetails(input);
  const before = await getVoice(id);
  if (input.isActive && before.providerVoiceId === "REPLACE_ME") {
    throw new ServiceError("validation", "זה קול לדוגמה בלי קול אמיתי מאחוריו, ואי אפשר להפעיל אותו.");
  }

  let providerConfig = before.providerConfig;
  if (isVoiceProvider(before.provider)) {
    // מודל שלא השתנה לא נבדק שוב: הוא הגיע מ-Vapi או נבדק כשנשמר
    const currentModel = (before.providerConfig as Cfg | null)?.model;
    checkTuning(before.provider, { ...input, model: input.model === currentModel ? undefined : input.model });
    const base = before.providerConfig ?? { provider: before.provider, voiceId: before.providerVoiceId };
    providerConfig = applyTuning(before.provider, base, input);
  }
  const tuningChanged = JSON.stringify(providerConfig) !== JSON.stringify(before.providerConfig);

  const db = getDb();
  const [voice] = await db
    .update(voices)
    .set({
      name: input.name.trim(),
      gender: input.gender as VoiceRow["gender"],
      description: input.description.trim(),
      tier: input.tier as VoiceRow["tier"],
      sortOrder: Math.round(input.sortOrder) || 0,
      isActive: input.isActive,
      providerConfig,
    })
    .where(eq(voices.id, id))
    .returning();
  await db
    .insert(auditLog)
    .values({ actorType: "admin", action: "voice.update", before: forLog(before), after: forLog(voice) });
  return { voice, tuningChanged };
}

// ---------- הוספה ----------

export interface NewVoiceInput extends VoiceDetailsInput {
  provider: string;
  providerVoiceId: string;
}

const PROVIDER_VOICE_ID = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * מוסיף קול לפי ה-ID שלו אצל הספק. הקול נשמר עם המודל והכיוונונים שנבחרו,
 * ומשם הוא נבנה לכל בקשה ל-Vapi. אחרי ההוספה כדאי ליצור דוגמה: אם היא נוצרת, ה-ID תקין.
 */
export async function addVoice(input: NewVoiceInput): Promise<VoiceRow> {
  if (!isVoiceProvider(input.provider)) throw new ServiceError("validation", "ספק לא נתמך.");
  const providerVoiceId = input.providerVoiceId.trim();
  if (!PROVIDER_VOICE_ID.test(providerVoiceId)) {
    throw new ServiceError("validation", "ה-Voice ID לא תקין. מעתיקים אותו מ-ElevenLabs או מ-Cartesia, בלי רווחים.");
  }
  checkDetails(input);
  checkTuning(input.provider, input);

  const db = getDb();
  const [existing] = await db
    .select({ id: voices.id, name: voices.name })
    .from(voices)
    .where(and(eq(voices.provider, input.provider), eq(voices.providerVoiceId, providerVoiceId)));
  if (existing) {
    throw new ServiceError("validation", `הקול הזה כבר בקטלוג בשם "${existing.name}". אפשר לערוך אותו ברשימה.`);
  }

  const base: Cfg =
    input.provider === "cartesia"
      ? { provider: "cartesia", voiceId: providerVoiceId, language: "he" }
      : { provider: "11labs", voiceId: providerVoiceId };
  const providerConfig = applyTuning(input.provider, base, {
    ...input,
    model: input.model || PROVIDERS[input.provider].defaultModel,
  });

  const [created] = await db
    .insert(voices)
    .values({
      id: slugFor(input.provider, providerVoiceId),
      name: input.name.trim(),
      gender: input.gender as VoiceRow["gender"],
      description: input.description.trim(),
      tier: input.tier as VoiceRow["tier"],
      provider: input.provider,
      providerVoiceId,
      providerConfig,
      isActive: input.isActive,
      sortOrder: Math.round(input.sortOrder) || 50,
    })
    .onConflictDoNothing()
    .returning();
  if (!created) throw new ServiceError("validation", "כבר יש קול עם מזהה דומה. אפשר לערוך אותו ברשימה.");
  await db.insert(auditLog).values({ actorType: "admin", action: "voice.create", after: forLog(created) });
  return created;
}

// ---------- דוגמאות שמע ----------

/** מייצר דוגמה מחדש אצל הספק. זורק ServiceError עם הסיבה אם נכשל. */
export async function generateSample(id: string): Promise<void> {
  const [result] = await generateVoiceSamples({ voiceId: id, force: true });
  if (result?.status === "created") return;
  throw new ServiceError("validation", `לא נוצרה דוגמה: ${result?.reason ?? "סיבה לא ידועה"}`);
}

export async function uploadSample(id: string, bytes: Buffer): Promise<void> {
  await getVoice(id);
  const problem = checkMp3(bytes);
  if (problem) throw new ServiceError("validation", problem);
  await saveVoiceSample(id, bytes);
  await getDb()
    .insert(auditLog)
    .values({ actorType: "admin", action: "voice.sample_upload", after: { voiceId: id, bytes: bytes.length } });
}

// ---------- החלה על ה-assistants ----------

/**
 * שינוי מודל או כיוונונים בקטלוג חל אוטומטית על כל בחירה חדשה של הקול ועל שיחות ניסיון.
 * assistant שכבר עובד עם הקול ממשיך עם ההגדרה הקודמת עד שהלקוח מחליף קול. הפונקציה הזו
 * מעדכנת אותם עכשיו: עוברת על ה-assistants של הלקוחות, ובכל אחד שהקול החי שלו ב-Vapi
 * הוא הקול הזה, שולחת את הקול המעודכן. assistant עם קול אחר לא נוגעים בו.
 */
export async function applyVoiceToAssistants(id: string): Promise<{ updated: string[]; failed: string[] }> {
  if (!isVapiConfigured()) throw new ServiceError("not_configured", "VAPI_PRIVATE_KEY לא מוגדר בשרת.");
  const voice = await getVoice(id);
  if (!voice.providerConfig) throw new ServiceError("validation", "לקול הזה אין הגדרות שמורות, ואין מה להחיל.");

  const customers = await getDb()
    .select({ id: tenants.id, name: tenants.name, assistantId: tenants.vapiAssistantId })
    .from(tenants)
    .where(and(eq(tenants.type, "customer"), isNotNull(tenants.vapiAssistantId)));

  const updated: string[] = [];
  const failed: string[] = [];
  // אחד אחרי השני, כדי לא להיתקל במגבלת הקצב של Vapi
  for (const t of customers) {
    try {
      const assistant = await vapi.getAssistant(t.assistantId!);
      const live = assistant.voice;
      if (live?.provider !== voice.provider || String(live.voiceId) !== voice.providerVoiceId) continue;
      await vapi.updateAssistant(t.assistantId!, { voice: buildVoice(voice, live) });
      updated.push(t.name);
    } catch (err) {
      if (!(err instanceof VapiError)) throw err;
      console.error("apply voice failed:", t.id, err.status, err.message);
      failed.push(t.name);
    }
  }
  await getDb()
    .insert(auditLog)
    .values({
      actorType: "admin",
      action: "voice.apply",
      after: { voiceId: id, providerConfig: voice.providerConfig, updated, failed },
    });
  return { updated, failed };
}
