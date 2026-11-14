// סגנון השיחה בצד השרת: מה זה "מהיר" ו"סבלני" (כללי ולכל לקוח), ואיך הבחירות של הלקוח
// הופכות לשדות של Vapi. הלקוח שולח רק בחירה ("fast", דרגה 1), והמספרים נקבעים כאן בלבד.

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { customerFeatures, responsePresets, type ResponseTiming, type VoiceRow } from "@/db/schema";
import {
  FEATURE_KEYS,
  NO_FEATURES,
  type BackgroundSound,
  type CustomerFeatures,
  type ResponseStyle,
  type Step,
} from "@/lib/conversation-style";
import { buildVoice } from "./vapi";
import type { BotSettings } from "@/lib/types";
import { ServiceError } from "./errors";
import type { VapiAssistant, VapiVoice } from "./vapi-client";

export type TimingPresets = Record<ResponseStyle, ResponseTiming>;

/** ברירת המחדל: אמצע הטווחים מהטבלה. אפשר לשנות בפאנל, לכולם או ללקוח מסוים. */
export const DEFAULT_PRESETS: TimingPresets = {
  fast: { waitSeconds: 0.1, onPunctuationSeconds: 0.1, onNoPunctuationSeconds: 0.9, onNumberSeconds: 0.4, endOfTurnSeconds: 0.25 },
  patient: { waitSeconds: 0.5, onPunctuationSeconds: 0.35, onNoPunctuationSeconds: 2, onNumberSeconds: 0.9, endOfTurnSeconds: 0.65 },
};

/** הגבולות ש-Vapi מקבל (מה-OpenAPI שלו). End-of-turn מומר לכל ספק לפי הגבולות שלו. */
export const TIMING_FIELDS: { key: keyof ResponseTiming; label: string; min: number; max: number }[] = [
  { key: "waitSeconds", label: "Wait Seconds (השהיית בסיס)", min: 0, max: 5 },
  { key: "onPunctuationSeconds", label: "On Punctuation Seconds", min: 0, max: 3 },
  { key: "onNoPunctuationSeconds", label: "On No Punctuation Seconds", min: 0, max: 3 },
  { key: "onNumberSeconds", label: "On Number Seconds", min: 0, max: 3 },
  { key: "endOfTurnSeconds", label: "End-of-Turn Wait (בתמלול)", min: 0.01, max: 3 },
];

export function checkTiming(t: ResponseTiming, label: string): ResponseTiming {
  const out = {} as ResponseTiming;
  for (const f of TIMING_FIELDS) {
    const v = t[f.key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < f.min || v > f.max) {
      throw new ServiceError("validation", `${label}: ${f.label} צריך להיות בין ${f.min} ל-${f.max}.`);
    }
    out[f.key] = Math.round(v * 1000) / 1000;
  }
  return out;
}

// ---------- איפה הערכים נשמרים ----------

const GLOBAL = "global";

/** קוד השגיאה של Postgres לטבלה שלא קיימת: מיגרציה 0007 עוד לא הורצה */
function isMissingTable(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "42P01" || e?.cause?.code === "42P01";
}

async function readRows(scopes: string[]) {
  try {
    const db = getDb();
    const rows = await Promise.all(scopes.map((s) => db.select().from(responsePresets).where(eq(responsePresets.scope, s))));
    return rows.map((r) => r[0] ?? null);
  } catch (err) {
    // בלי הטבלה: ברירות המחדל, כדי ששום דבר לא יישבר עד שמריצים את המיגרציה
    if (isMissingTable(err)) return scopes.map(() => null);
    throw err;
  }
}

export interface PresetsForTenant {
  /** מה שחל על הלקוח בפועל */
  effective: TimingPresets;
  global: TimingPresets;
  /** הערכים המיוחדים של הלקוח, אם יש */
  override: Partial<TimingPresets>;
}

export async function globalPresets(): Promise<TimingPresets> {
  const [row] = await readRows([GLOBAL]);
  return { fast: row?.fast ?? DEFAULT_PRESETS.fast, patient: row?.patient ?? DEFAULT_PRESETS.patient };
}

export async function presetsForTenant(tenantId: string): Promise<PresetsForTenant> {
  const [globalRow, tenantRow] = await readRows([GLOBAL, tenantId]);
  const global = {
    fast: globalRow?.fast ?? DEFAULT_PRESETS.fast,
    patient: globalRow?.patient ?? DEFAULT_PRESETS.patient,
  };
  const override: Partial<TimingPresets> = {};
  if (tenantRow?.fast) override.fast = tenantRow.fast;
  if (tenantRow?.patient) override.patient = tenantRow.patient;
  return { global, override, effective: { ...global, ...override } };
}

/** כל הלקוחות שיש להם ערכים משלהם, לפי קצב. כדי לדלג עליהם כשמשנים את הכלליים. */
export async function tenantOverrides(): Promise<Map<string, Partial<TimingPresets>>> {
  try {
    const rows = await getDb().select().from(responsePresets);
    return new Map(
      rows
        .filter((r) => r.scope !== GLOBAL)
        .map((r) => [r.scope, { ...(r.fast ? { fast: r.fast } : {}), ...(r.patient ? { patient: r.patient } : {}) }]),
    );
  } catch (err) {
    if (isMissingTable(err)) return new Map();
    throw err;
  }
}

export async function saveGlobalPresets(presets: TimingPresets) {
  const value = { fast: checkTiming(presets.fast, "מהיר"), patient: checkTiming(presets.patient, "סבלני") };
  await getDb()
    .insert(responsePresets)
    .values({ scope: GLOBAL, ...value })
    .onConflictDoUpdate({ target: responsePresets.scope, set: { ...value, updatedAt: new Date() } });
  return value;
}

/** null = הלקוח חוזר לערכים הכלליים */
export async function saveTenantPresets(tenantId: string, presets: Partial<TimingPresets> | null) {
  const db = getDb();
  if (!presets || (!presets.fast && !presets.patient)) {
    await db.delete(responsePresets).where(eq(responsePresets.scope, tenantId));
    return;
  }
  const value = {
    fast: presets.fast ? checkTiming(presets.fast, "מהיר") : null,
    patient: presets.patient ? checkTiming(presets.patient, "סבלני") : null,
  };
  await db
    .insert(responsePresets)
    .values({ scope: tenantId, ...value })
    .onConflictDoUpdate({ target: responsePresets.scope, set: { ...value, updatedAt: new Date() } });
}

// ---------- מה פתוח לכל לקוח ----------

function toFeatures(raw: Record<string, boolean> | null | undefined): CustomerFeatures {
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, raw?.[k] === true])) as CustomerFeatures;
}

/** מה פתוח ללקוח. בלי שורה (או בלי הטבלה, לפני מיגרציה 0008): הכול סגור. */
export async function featuresForTenant(tenantId: string): Promise<CustomerFeatures> {
  try {
    const [row] = await getDb().select().from(customerFeatures).where(eq(customerFeatures.tenantId, tenantId));
    return toFeatures(row?.features);
  } catch (err) {
    if (isMissingTable(err)) return { ...NO_FEATURES };
    throw err;
  }
}

/** של כל הלקוחות שיש להם משהו פתוח */
export async function featuresByTenant(): Promise<Map<string, CustomerFeatures>> {
  try {
    const rows = await getDb().select().from(customerFeatures);
    return new Map(rows.map((r) => [r.tenantId, toFeatures(r.features)]));
  } catch (err) {
    if (isMissingTable(err)) return new Map();
    throw err;
  }
}

export async function saveFeatures(tenantId: string, features: CustomerFeatures): Promise<CustomerFeatures> {
  const value = toFeatures(features);
  await getDb()
    .insert(customerFeatures)
    .values({ tenantId, features: value })
    .onConflictDoUpdate({ target: customerFeatures.tenantId, set: { features: value, updatedAt: new Date() } });
  return value;
}

// ---------- מבחירה לשדות של Vapi ----------

/**
 * End-of-turn בתמלול הוא שדה אחר אצל כל ספק, ביחידות ובגבולות שונים (מה-OpenAPI של Vapi).
 * ספק שלא ברשימה (Google, OpenAI, Cartesia ועוד) לא חושף הגדרה כזו.
 */
const END_OF_TURN: Record<
  string,
  { field: string; unit: "ms" | "s"; min: number; max: number; skip?: (t: Record<string, unknown>) => string | null }
> = {
  deepgram: {
    field: "endpointing",
    unit: "ms",
    min: 10,
    max: 500,
    skip: (t) => (String(t.model ?? "").startsWith("flux") ? "ב-Deepgram Flux סוף התור נקבע במודל עצמו" : null),
  },
  azure: { field: "segmentationSilenceTimeoutMs", unit: "ms", min: 100, max: 5000 },
  gladia: { field: "endpointing", unit: "s", min: 0.01, max: 10 },
  "11labs": { field: "silenceThresholdSeconds", unit: "s", min: 0.3, max: 3 },
  "assembly-ai": { field: "minEndOfTurnSilenceWhenConfident", unit: "ms", min: 0, max: 10_000 },
  soniox: { field: "maxEndpointDelayMs", unit: "ms", min: 500, max: 3000 },
};

export interface TimingFields {
  startSpeakingPlan: Record<string, unknown>;
  /** undefined: לא נוגעים בתמלול (אין שדה מתאים אצל הספק) */
  transcriber?: Record<string, unknown>;
  /** הסברים לאדמין: ספק לא נתמך, ערך שנחתך לגבולות של הספק */
  notes: string[];
}

/**
 * השדות ש-Vapi צריך כדי לעבוד בקצב מסוים. Vapi מחליף אובייקטים שלמים בעדכון,
 * ולכן startSpeakingPlan ו-transcriber נשלחים מלאים: מה שהיה ב-assistant, עם השינויים שלנו.
 * Smart Endpointing נכבה, כי כשהוא פעיל Vapi מתעלם מערכי ה-Punctuation (כך הוחלט).
 */
export function timingFields(assistant: VapiAssistant | null, timing: ResponseTiming): TimingFields {
  const notes: string[] = [];
  const current = { ...((assistant?.startSpeakingPlan as Record<string, unknown> | undefined) ?? {}) };
  delete current.smartEndpointingPlan;
  const startSpeakingPlan = {
    ...current,
    waitSeconds: timing.waitSeconds,
    smartEndpointingEnabled: false,
    transcriptionEndpointingPlan: {
      onPunctuationSeconds: timing.onPunctuationSeconds,
      onNoPunctuationSeconds: timing.onNoPunctuationSeconds,
      onNumberSeconds: timing.onNumberSeconds,
    },
  };

  const t = assistant?.transcriber as Record<string, unknown> | undefined;
  const provider = typeof t?.provider === "string" ? t.provider : null;
  const spec = provider ? END_OF_TURN[provider] : undefined;
  if (!t || !provider) {
    notes.push("ל-assistant אין הגדרת תמלול, ולכן End-of-Turn לא נשלח.");
    return { startSpeakingPlan, notes };
  }
  if (!spec) {
    notes.push(`ספק התמלול ${provider} לא תומך בהגדרת End-of-Turn, ולכן היא לא נשלחת.`);
    return { startSpeakingPlan, notes };
  }
  const skipped = spec.skip?.(t);
  if (skipped) {
    notes.push(`${skipped}, ולכן End-of-Turn לא נשלח.`);
    return { startSpeakingPlan, notes };
  }
  const wanted = spec.unit === "ms" ? Math.round(timing.endOfTurnSeconds * 1000) : timing.endOfTurnSeconds;
  const value = Math.min(spec.max, Math.max(spec.min, wanted));
  if (value !== wanted) {
    notes.push(`ב-${provider} הטווח של ${spec.field} הוא ${spec.min}-${spec.max}${spec.unit}. נשלח ${value}${spec.unit}.`);
  }
  return { startSpeakingPlan, transcriber: { ...t, [spec.field]: value }, notes };
}

/** איזה קצב מוגדר עכשיו ב-assistant. null אם הערכים לא תואמים אף אחד מהשניים (או שלא הוגדר). */
export function styleFromAssistant(assistant: VapiAssistant, presets: TimingPresets): ResponseStyle | null {
  const plan = assistant.startSpeakingPlan as Record<string, unknown> | undefined;
  const tep = plan?.transcriptionEndpointingPlan as Record<string, unknown> | undefined;
  if (!plan || !tep) return null;
  const same = (a: unknown, b: number) => typeof a === "number" && Math.abs(a - b) < 0.0005;
  for (const style of ["fast", "patient"] as const) {
    const p = presets[style];
    if (
      same(plan.waitSeconds, p.waitSeconds) &&
      same(tep.onPunctuationSeconds, p.onPunctuationSeconds) &&
      same(tep.onNoPunctuationSeconds, p.onNoPunctuationSeconds) &&
      same(tep.onNumberSeconds, p.onNumberSeconds)
    ) {
      return style;
    }
  }
  return null;
}

/** רעשי רקע ב-assistant. כש-Vapi לא מקבל ערך, ברירת המחדל שלו לשיחות טלפון היא office. */
export function backgroundFromAssistant(assistant: VapiAssistant): BackgroundSound {
  return assistant.backgroundSound === "off" ? "off" : "office";
}

// ---------- קצב דיבור ועוצמה ----------

/** הכפלה של הבסיס של הקול לכל דרגה */
const SPEED_FACTOR: Record<Step, number> = { [-2]: 0.85, [-1]: 0.93, 0: 1, 1: 1.07, 2: 1.15 };
const VOLUME_FACTOR: Record<Step, number> = { [-2]: 0.6, [-1]: 0.8, 0: 1, 1: 1.25, 2: 1.5 };

type Cfg = Record<string, unknown>;
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const clamp = (v: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, v)) * 100) / 100;

/** עוצמה אפשר לשנות ב-Vapi רק בקולות של Cartesia במודלים של sonic-3 */
export function supportsVolume(provider: string, cfg: Cfg | null | undefined): boolean {
  return provider === "cartesia" && String(cfg?.model ?? "sonic-3").startsWith("sonic-3");
}

/**
 * הקול לשליחה ל-Vapi, אחרי קצב הדיבור והעוצמה שהלקוח בחר. הבסיס הוא הקול כפי שהוגדר בקטלוג,
 * ודרגה 0 משאירה אותו בדיוק כמו שהוא. התוצאה נחתכת לגבולות של הספק.
 */
export function adjustVoice(voice: VapiVoice, rate: Step | undefined, volume: Step | undefined): VapiVoice {
  const r = rate ?? 0;
  const v = volume ?? 0;
  if (r === 0 && v === 0) return voice;
  if (voice.provider === "11labs") {
    return r === 0 ? voice : { ...voice, speed: clamp(num(voice.speed, 1) * SPEED_FACTOR[r], 0.7, 1.2) };
  }
  if (voice.provider === "cartesia") {
    const gen: Cfg = { ...((voice.generationConfig as Cfg | undefined) ?? {}) };
    if (r !== 0) gen.speed = clamp(num(gen.speed, 1) * SPEED_FACTOR[r], 0.6, 1.5);
    if (v !== 0 && supportsVolume("cartesia", voice)) gen.volume = clamp(num(gen.volume, 1) * VOLUME_FACTOR[v], 0.5, 2);
    return { ...voice, generationConfig: gen };
  }
  return voice;
}

const speedOf = (v: VapiVoice) =>
  v.provider === "cartesia" ? num((v.generationConfig as Cfg | undefined)?.speed, 1) : num(v.speed, 1);
const volumeOf = (v: VapiVoice) => num((v.generationConfig as Cfg | undefined)?.volume, 1);

/** הדרגות שנותנות בדיוק את הערך שיש ב-Vapi (כמה דרגות יכולות להיחתך לאותו ערך) */
function matchingSteps(live: number, at: (s: Step) => number): Step[] {
  return ([0, -1, 1, -2, 2] as const).filter((s) => Math.abs(at(s) - live) < 0.005);
}

function pick(candidates: Step[], saved: Step | undefined): Step {
  if (saved !== undefined && candidates.includes(saved)) return saved;
  return candidates[0] ?? 0;
}

/**
 * איזו דרגה מוגדרת עכשיו ב-Vapi, לפי הקול בקטלוג. רק התאמה מדויקת נחשבת: אם המהירות שונתה ידנית
 * ב-Vapi לערך שלא מתאים לאף דרגה, מוצג "רגיל" (0), וכלום לא נשלח עד שהלקוח בוחר בעצמו.
 * saved: מה שנשמר בפעם האחרונה, כשכמה דרגות נותנות אותו ערך (למשל שתיהן נחתכו למקסימום).
 */
export function stepsFromVoice(
  live: VapiVoice | undefined,
  catalog: VoiceRow | null,
  saved?: { speechRate?: Step; volume?: Step } | null,
): { speechRate: Step; volume: Step } {
  if (!live || !catalog?.providerConfig || live.provider !== catalog.provider) return { speechRate: 0, volume: 0 };
  if (live.provider !== "11labs" && live.provider !== "cartesia") return { speechRate: 0, volume: 0 };
  const base = buildVoice(catalog);
  const speechRate = pick(matchingSteps(speedOf(live), (s) => speedOf(adjustVoice(base, s, 0))), saved?.speechRate);
  const volume =
    live.provider === "cartesia"
      ? pick(matchingSteps(volumeOf(live), (s) => volumeOf(adjustVoice(base, 0, s))), saved?.volume)
      : 0;
  return { speechRate, volume };
}

/** האם השתנה משהו שמשפיע על הקול שנשלח */
export function voiceAdjustmentsChanged(a: BotSettings, b: BotSettings | null): boolean {
  return !b || (a.speechRate ?? 0) !== (b.speechRate ?? 0) || (a.volume ?? 0) !== (b.volume ?? 0);
}
