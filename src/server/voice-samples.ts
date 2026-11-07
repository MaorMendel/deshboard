// דוגמאות שמע לקולות: משפט קצר שכל קול אומר, כדי שהלקוח ישמע אותו לפני שהוא בוחר.
// שתי דרכים ליצור דוגמה, שתיהן רק מפאנל הניהול או מפקודה, אף פעם לא מבקשה של לקוח:
// 1. יצירה אצל הספק (Cartesia או ElevenLabs) עם אותן הגדרות שיש לקול ב-Vapi.
// 2. העלאת קובץ MP3 מוכן, לכל קול מכל ספק.
//
// הדוגמה נשמרת בטבלת voices עצמה ולא בתיקיית public: Next מאנדקס את public כשהשרת עולה,
// ולכן קובץ שנוצר אחר כך לא מוגש עד הפעלה מחדש. ב-DB הדוגמה זמינה מיד.

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { voices, type VoiceRow } from "@/db/schema";
import { cartesia } from "./cartesia-client";
import { elevenlabs } from "./elevenlabs-client";

export const DEFAULT_SAMPLE_TEXT =
  "היי, תודה שהתקשרתם! אני כאן כדי לעזור, לקבוע תור או לענות על כל שאלה. במה אפשר לעזור?";

/** הספקים שאפשר ליצור להם דוגמה אוטומטית. לשאר: העלאת MP3. */
export const SAMPLE_PROVIDERS = ["cartesia", "11labs"] as const;

/** גודל מקסימלי לקובץ דוגמה שמעלים. משפט של 10-20 שניות הוא בערך 150-300KB. */
export const SAMPLE_MAX_BYTES = 2 * 1024 * 1024;

/** הכתובת שהדפדפן פונה אליה. ה-v מבטיח שדוגמה חדשה לא תיתקע במטמון של הדפדפן. */
export function sampleUrlFor(voiceId: string, updatedAt: Date): string {
  return `/api/voice-samples/${encodeURIComponent(voiceId)}?v=${updatedAt.getTime()}`;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function withoutUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> | undefined {
  const out = Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
  return Object.keys(out).length ? out : undefined;
}

/**
 * מה-voice של Vapi (CartesiaVoice) לגוף הבקשה של Cartesia.
 * שדות שלא הוגדרו ב-Vapi לא נשלחים, ו-Cartesia משתמש בברירת המחדל שלו.
 */
function cartesiaBody(voice: VoiceRow, text: string, modelOverride?: string) {
  const cfg = (voice.providerConfig ?? {}) as Record<string, unknown>;
  const gen = (cfg.generationConfig ?? {}) as Record<string, unknown>;
  return {
    model_id: modelOverride ?? str(cfg.model) ?? "sonic-3.6",
    transcript: text,
    voice: { id: voice.providerVoiceId },
    language: str(cfg.language) ?? "he",
    output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
    generation_config: withoutUndefined({ speed: gen.speed, volume: gen.volume }),
    pronunciation_dict_id: str(cfg.pronunciationDictId),
  };
}

/**
 * מה-voice של Vapi (ElevenLabsVoice) לגוף הבקשה של ElevenLabs.
 * השמות שונים בין השניים (similarityBoost ב-Vapi, similarity_boost ב-ElevenLabs), אבל המשמעות זהה.
 */
function elevenLabsBody(voice: VoiceRow, text: string, modelOverride?: string) {
  const cfg = (voice.providerConfig ?? {}) as Record<string, unknown>;
  return {
    text,
    // בלי מודל מוגדר, Vapi בוחר ברירת מחדל משלו. כדאי לקבוע מודל במסך הקולות כדי שהדוגמה תישמע בדיוק כמו בשיחה.
    model_id: modelOverride ?? str(cfg.model) ?? "eleven_turbo_v2_5",
    language_code: str(cfg.language),
    voice_settings: withoutUndefined({
      stability: num(cfg.stability),
      similarity_boost: num(cfg.similarityBoost),
      style: num(cfg.style),
      use_speaker_boost: typeof cfg.useSpeakerBoost === "boolean" ? cfg.useSpeakerBoost : undefined,
      speed: num(cfg.speed),
    }),
  };
}

/** מייצר את הקובץ אצל הספק של הקול. זורק אם הספק לא נתמך או שהבקשה נכשלה. */
async function synthesize(voice: VoiceRow, text: string, modelOverride?: string): Promise<Buffer> {
  if (voice.provider === "cartesia") return cartesia.tts(cartesiaBody(voice, text, modelOverride));
  if (voice.provider === "11labs")
    return elevenlabs.tts(voice.providerVoiceId, elevenLabsBody(voice, text, modelOverride));
  throw new Error(`אין יצירה אוטומטית לספק ${voice.provider}. אפשר להעלות קובץ MP3 במסך הקולות.`);
}

/** שומר דוגמה לקול ומחזיר את הכתובת שלה */
export async function saveVoiceSample(voiceId: string, audio: Buffer): Promise<string> {
  const now = new Date();
  const url = sampleUrlFor(voiceId, now);
  await getDb()
    .update(voices)
    .set({ sampleAudio: audio, sampleUpdatedAt: now, sampleUrl: url })
    .where(eq(voices.id, voiceId));
  return url;
}

/**
 * בודק שהקובץ הוא באמת MP3 לפני ששומרים אותו, כי הוא מוגש ללקוחות כ-audio/mpeg.
 * MP3 מתחיל בתגית ID3, או ישר ב-frame של אודיו (11 ביטים דולקים).
 */
export function checkMp3(bytes: Buffer): string | null {
  if (bytes.length === 0) return "הקובץ ריק.";
  if (bytes.length > SAMPLE_MAX_BYTES) return `הקובץ גדול מדי. אפשר עד ${SAMPLE_MAX_BYTES / 1024 / 1024}MB.`;
  const id3 = bytes.subarray(0, 3).toString("latin1") === "ID3";
  const frameSync = bytes.length > 1 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  if (!id3 && !frameSync) return "זה לא נראה כמו קובץ MP3. אפשר להמיר אותו ל-MP3 ולנסות שוב.";
  return null;
}

export interface SampleResult {
  id: string;
  name: string;
  status: "created" | "skipped" | "failed";
  reason?: string;
}

/**
 * מייצר דוגמת שמע לכל קול שעוד אין לו, ושומר אותה בטבלה.
 * force: מייצר מחדש גם לקולות שכבר יש להם דוגמה. voiceId: רק לקול אחד.
 */
export async function generateVoiceSamples(
  opts: { voiceId?: string; force?: boolean; text?: string; model?: string } = {},
): Promise<SampleResult[]> {
  const db = getDb();
  const rows = opts.voiceId
    ? await db.select().from(voices).where(eq(voices.id, opts.voiceId))
    : await db.select().from(voices);
  if (opts.voiceId && !rows.length) throw new Error(`אין קול עם id ${opts.voiceId}`);

  const results: SampleResult[] = [];
  for (const voice of rows) {
    const base = { id: voice.id, name: voice.name };
    if (voice.providerVoiceId === "REPLACE_ME") {
      results.push({ ...base, status: "skipped", reason: "קול לדוגמה, לא אמיתי" });
      continue;
    }
    if (!(SAMPLE_PROVIDERS as readonly string[]).includes(voice.provider)) {
      results.push({
        ...base,
        status: "skipped",
        reason: `אין יצירה אוטומטית לספק ${voice.provider}. אפשר להעלות MP3 במסך הקולות.`,
      });
      continue;
    }
    if (voice.sampleAudio && !opts.force) {
      results.push({ ...base, status: "skipped", reason: "כבר יש דוגמה (להחלפה: --force)" });
      continue;
    }
    try {
      const audio = await synthesize(voice, opts.text ?? DEFAULT_SAMPLE_TEXT, opts.model);
      await saveVoiceSample(voice.id, audio);
      results.push({ ...base, status: "created" });
    } catch (err) {
      results.push({ ...base, status: "failed", reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/** הדוגמה של קול אחד, להגשה ב-route. null אם אין. */
export async function voiceSample(voiceId: string): Promise<{ audio: Buffer; updatedAt: Date } | null> {
  const [row] = await getDb()
    .select({ audio: voices.sampleAudio, updatedAt: voices.sampleUpdatedAt })
    .from(voices)
    .where(eq(voices.id, voiceId));
  if (!row?.audio) return null;
  return { audio: row.audio, updatedAt: row.updatedAt ?? new Date(0) };
}
