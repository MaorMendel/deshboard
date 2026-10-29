// דוגמאות שמע לקולות: משפט קצר שכל קול אומר, כדי שהלקוח ישמע אותו לפני שהוא בוחר.
// נוצרות ב-Cartesia עם אותן הגדרות שיש לקול ב-Vapi, ונשמרות בטבלת voices עצמה.
//
// למה ב-DB ולא בתיקיית public: Next מאנדקס את public כשהשרת עולה, ולכן קובץ שנוצר אחר כך
// לא מוגש עד הפעלה מחדש. ב-DB הדוגמה זמינה מיד, וגם כשמריצים את הפקודה מהמחשב מול פרודקשן.

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { voices, type VoiceRow } from "@/db/schema";
import { cartesia } from "./cartesia-client";

export const DEFAULT_SAMPLE_TEXT = "היי, תודה שהתקשרתם! אני כאן כדי לעזור, לקבוע תור או לענות על כל שאלה. במה אפשר לעזור?";

/** הכתובת שהדפדפן פונה אליה. ה-v מבטיח שדוגמה חדשה לא תיתקע במטמון של הדפדפן. */
export function sampleUrlFor(voiceId: string, updatedAt: Date): string {
  return `/api/voice-samples/${encodeURIComponent(voiceId)}?v=${updatedAt.getTime()}`;
}

/**
 * מה-voice של Vapi (CartesiaVoice) לגוף הבקשה של Cartesia.
 * שדות שלא הוגדרו ב-Vapi לא נשלחים, ו-Cartesia משתמש בברירת המחדל שלו.
 */
function cartesiaBody(voice: VoiceRow, text: string, modelOverride?: string) {
  const cfg = (voice.providerConfig ?? {}) as Record<string, unknown>;
  const gen = (cfg.generationConfig ?? {}) as Record<string, unknown>;
  const generationConfig: Record<string, unknown> = { speed: gen.speed, volume: gen.volume };
  for (const k of Object.keys(generationConfig)) if (generationConfig[k] === undefined) delete generationConfig[k];
  return {
    model_id: modelOverride ?? (typeof cfg.model === "string" ? cfg.model : "sonic-3.6"),
    transcript: text,
    voice: { id: voice.providerVoiceId },
    language: typeof cfg.language === "string" ? cfg.language : "he",
    output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
    generation_config: Object.keys(generationConfig).length ? generationConfig : undefined,
    pronunciation_dict_id: typeof cfg.pronunciationDictId === "string" ? cfg.pronunciationDictId : undefined,
  };
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
    if (voice.provider !== "cartesia") {
      results.push({ ...base, status: "skipped", reason: `ספק ${voice.provider} לא נתמך. אפשר לשים כתובת ידנית ב-sample_url` });
      continue;
    }
    if (voice.sampleAudio && !opts.force) {
      results.push({ ...base, status: "skipped", reason: "כבר יש דוגמה (להחלפה: --force)" });
      continue;
    }
    try {
      const audio = await cartesia.tts(cartesiaBody(voice, opts.text ?? DEFAULT_SAMPLE_TEXT, opts.model));
      const now = new Date();
      await db
        .update(voices)
        .set({ sampleAudio: audio, sampleUpdatedAt: now, sampleUrl: sampleUrlFor(voice.id, now) })
        .where(eq(voices.id, voice.id));
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
