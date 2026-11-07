// קטלוג הקולות נמצא בטבלת voices. כאן: הקריאה ממנו, וייבוא קולות מה-assistants הקיימים ב-Vapi.

import { and, asc, eq, or } from "drizzle-orm";
import type { Voice } from "@/lib/types";
import { getDb } from "@/db";
import { voices, type VoiceRow } from "@/db/schema";
import { cartesia } from "./cartesia-client";
import { vapi, type VapiVoice } from "./vapi-client";

/** קולות לדוגמה, ל-seed של סביבת פיתוח בלבד. בפרודקשן הקולות מיובאים מ-Vapi. */
export const PLACEHOLDER_VOICES: Array<Pick<VoiceRow, "id" | "name" | "gender" | "description" | "provider" | "providerVoiceId" | "tier">> = [
  { id: "noa", name: "נועה", gender: "female", description: "חמה ורגועה", provider: "cartesia", providerVoiceId: "REPLACE_ME", tier: "standard" },
  { id: "itai", name: "איתי", gender: "male", description: "ענייני ומקצועי", provider: "cartesia", providerVoiceId: "REPLACE_ME", tier: "standard" },
  { id: "shira", name: "שירה", gender: "female", description: "צעירה ואנרגטית", provider: "cartesia", providerVoiceId: "REPLACE_ME", tier: "standard" },
  { id: "yoav", name: "יואב", gender: "male", description: "עמוק ובטוח", provider: "cartesia", providerVoiceId: "REPLACE_ME", tier: "standard" },
  { id: "michal", name: "מיכל", gender: "female", description: "רכה, מתאימה לקליניקות", provider: "cartesia", providerVoiceId: "REPLACE_ME", tier: "premium" },
  { id: "daniel", name: "דניאל", gender: "male", description: "רשמי, מתאים למשרדים", provider: "cartesia", providerVoiceId: "REPLACE_ME", tier: "premium" },
];

export function toPublicVoice(v: VoiceRow): Voice {
  return {
    id: v.id,
    name: v.name,
    gender: v.gender,
    description: v.description,
    sampleUrl: v.sampleUrl,
    tier: v.tier,
  };
}

/** הקולות שלקוח יכול לבחור: כל הפעילים, ובנוסף הקול הנוכחי שלו גם אם הוא כבוי */
export async function selectableVoices(currentVoiceId?: string): Promise<VoiceRow[]> {
  const db = getDb();
  return db
    .select()
    .from(voices)
    .where(currentVoiceId ? or(eq(voices.isActive, true), eq(voices.id, currentVoiceId)) : eq(voices.isActive, true))
    .orderBy(asc(voices.sortOrder), asc(voices.name));
}

// השם והתיאור שקול מיובא מקבל, עד שמישהו נותן לו שם ותיאור אמיתיים.
// לפי אלה יודעים שמותר להחליף אותם, ולא לדרוס שם שנקבע בכוונה.
export const IMPORTED_NAME_PREFIX = "קול מ-";
export const IMPORTED_DESCRIPTION = "יובא מ-Vapi. צריך לעדכן שם, מגדר ותיאור, ואז להפעיל.";

/** הקול בקטלוג שמתאים לקול שמוגדר ב-assistant. null אם הוא לא קיים אצלנו. */
export async function findCatalogVoice(voice: VapiVoice | undefined): Promise<VoiceRow | null> {
  if (!voice?.provider || voice.voiceId == null) return null;
  const [row] = await getDb()
    .select()
    .from(voices)
    .where(and(eq(voices.provider, voice.provider), eq(voices.providerVoiceId, String(voice.voiceId))));
  return row ?? null;
}

export function slugFor(provider: string, providerVoiceId: string): string {
  return `${provider}-${providerVoiceId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/**
 * מוודא שקול מ-Vapi קיים בקטלוג ומחזיר אותו.
 * קול חדש נכנס כבוי, עם שם זמני, עד שמישהו נותן לו שם, מגדר ותיאור ומפעיל אותו.
 */
export async function ensureVoice(voice: VapiVoice, label: string): Promise<VoiceRow> {
  const db = getDb();
  const voiceId = String(voice.voiceId);
  const [existing] = await db
    .select()
    .from(voices)
    .where(and(eq(voices.provider, voice.provider), eq(voices.providerVoiceId, voiceId)));

  if (existing) {
    if (!existing.providerConfig) {
      const [updated] = await db
        .update(voices)
        .set({ providerConfig: voice })
        .where(eq(voices.id, existing.id))
        .returning();
      return updated;
    }
    return existing;
  }

  const [created] = await db
    .insert(voices)
    .values({
      id: slugFor(voice.provider, voiceId),
      name: label,
      gender: "female",
      description: IMPORTED_DESCRIPTION,
      provider: voice.provider,
      providerVoiceId: voiceId,
      providerConfig: voice,
      isActive: false,
      sortOrder: 100,
    })
    .onConflictDoNothing()
    .returning();

  if (created) return created;
  // מקרה נדיר: slug תפוס על ידי קול אחר. מחזירים את מה שיש.
  const [bySlug] = await db.select().from(voices).where(eq(voices.id, slugFor(voice.provider, voiceId)));
  return bySlug;
}

export interface AddCartesiaVoiceInput {
  voiceId: string;
  /** השם שהלקוח יראה. ברירת מחדל: השם ב-Cartesia */
  name?: string;
  /** ברירת מחדל: לפי Cartesia */
  gender?: "female" | "male";
  description?: string;
  tier?: "standard" | "premium";
  model?: string;
  speed?: number;
  sortOrder?: number;
  active?: boolean;
}

/**
 * מוסיף קול של Cartesia לפי ה-ID שלו, בלי שיהיה מוגדר על assistant.
 * בודק מול Cartesia שהקול קיים. קול שכבר בקטלוג מתעדכן בשם, בתיאור ובשאר הפרטים שנשלחו.
 */
export async function addCartesiaVoice(input: AddCartesiaVoiceInput): Promise<{ voice: VoiceRow; isNew: boolean }> {
  const info = await cartesia.getVoice(input.voiceId);
  const gender =
    input.gender ?? (info.gender === "masculine" ? "male" : info.gender === "feminine" ? "female" : undefined);
  if (!gender) throw new Error(`ב-Cartesia לא מוגדר מגדר לקול ${info.name}. צריך להוסיף --gender female או male`);

  const providerConfig: VapiVoice = {
    provider: "cartesia",
    voiceId: info.id,
    model: input.model ?? "sonic-3.6",
    language: "he",
    ...(input.speed !== undefined && { generationConfig: { speed: input.speed } }),
  };
  const details = {
    name: input.name ?? info.name,
    gender,
    description: input.description ?? info.description?.slice(0, 80) ?? "",
    tier: input.tier ?? "standard",
    providerConfig,
    isActive: input.active ?? true,
    ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
  };

  const db = getDb();
  const [existing] = await db
    .select()
    .from(voices)
    .where(and(eq(voices.provider, "cartesia"), eq(voices.providerVoiceId, info.id)));
  if (existing) {
    // קול קיים: משנים רק את מה שנשלח, כדי ש---name לבד לא ידרוס את התיאור או את הכיוונונים
    const prev = (existing.providerConfig ?? providerConfig) as VapiVoice;
    // שם או תיאור שעוד לא נקבעו (כך נראה קול שיובא מ-Vapi) מתמלאים מ-Cartesia.
    // שם שנקבע בכוונה לא נדרס, אלא אם העבירו --name במפורש.
    const placeholderName = existing.name.startsWith(IMPORTED_NAME_PREFIX);
    const placeholderDescription = existing.description === IMPORTED_DESCRIPTION;
    const changes = {
      ...((input.name !== undefined || placeholderName) && { name: input.name ?? details.name }),
      ...(input.gender !== undefined && { gender: input.gender }),
      ...((input.description !== undefined || placeholderDescription) && {
        description: input.description ?? details.description,
      }),
      ...(input.tier !== undefined && { tier: input.tier }),
      ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
      ...(input.active !== undefined && { isActive: input.active }),
      ...((input.model !== undefined || input.speed !== undefined) && {
        providerConfig: {
          ...prev,
          ...(input.model !== undefined && { model: input.model }),
          ...(input.speed !== undefined && {
            generationConfig: { ...(prev.generationConfig as object | undefined), speed: input.speed },
          }),
        },
      }),
    };
    if (!Object.keys(changes).length) return { voice: existing, isNew: false };
    const [updated] = await db.update(voices).set(changes).where(eq(voices.id, existing.id)).returning();
    return { voice: updated, isNew: false };
  }
  const [created] = await db
    .insert(voices)
    .values({ id: slugFor("cartesia", info.id), provider: "cartesia", providerVoiceId: info.id, sortOrder: 50, ...details })
    .returning();
  return { voice: created, isNew: true };
}

/** עובר על כל ה-assistants בחשבון Vapi ומכניס לקטלוג כל קול שעוד לא קיים בו */
export async function importVoicesFromVapi() {
  const assistants = await vapi.listAssistants();
  const seen = new Map<string, { voice: VapiVoice; assistants: string[] }>();
  for (const a of assistants) {
    if (!a.voice?.provider || a.voice.voiceId == null) continue;
    const key = `${a.voice.provider}::${a.voice.voiceId}`;
    const entry = seen.get(key) ?? { voice: a.voice, assistants: [] };
    entry.assistants.push(a.name ?? a.id);
    seen.set(key, entry);
  }

  const db = getDb();
  const before = new Set((await db.select({ id: voices.id }).from(voices)).map((v) => v.id));
  const result: { id: string; name: string; isNew: boolean; usedBy: string[] }[] = [];
  for (const { voice, assistants: usedBy } of seen.values()) {
    const row = await ensureVoice(voice, `${IMPORTED_NAME_PREFIX}${usedBy[0]}`);
    result.push({ id: row.id, name: row.name, isNew: !before.has(row.id), usedBy });
  }
  return { assistantsScanned: assistants.length, voices: result };
}
