// הספקים שאפשר להוסיף מהם קולות בפאנל, ומה Vapi מקבל מכל אחד. רץ גם בדפדפן (בטפסים) וגם בשרת (בבדיקה).
// הרשימות לקוחות מה-OpenAPI של Vapi: ElevenLabsVoice ו-CartesiaVoice. ערך אחר נדחה ב-Vapi בשמירה.

export type VoiceProvider = "11labs" | "cartesia";

export interface ProviderSpec {
  label: string;
  models: readonly string[];
  defaultModel: string;
  /** טווח ה-speed ש-Vapi מקבל */
  speed: readonly [number, number];
  /** האם יש לספק stability (0-1) */
  stability: boolean;
  /** הסבר קצר ליד בחירת המודל */
  modelHint: string;
}

export const PROVIDERS: Record<VoiceProvider, ProviderSpec> = {
  "11labs": {
    label: "ElevenLabs",
    models: [
      "eleven_v3",
      "eleven_v3_conversational",
      "eleven_v4_turbo",
      "eleven_multilingual_v2",
      "eleven_turbo_v2_5",
      "eleven_flash_v2_5",
      "eleven_turbo_v2",
      "eleven_flash_v2",
      "eleven_monolingual_v1",
    ],
    defaultModel: "eleven_v3",
    speed: [0.7, 1.2],
    stability: true,
    modelHint: "לפי ElevenLabs, eleven_v3 תומך בעברית, ו-multilingual_v2 ו-flash_v2_5 לא. כדאי ליצור דוגמה ולשמוע.",
  },
  cartesia: {
    label: "Cartesia",
    models: [
      "sonic-3.6",
      "sonic-3.6-2026-08-27",
      "sonic-3.5",
      "sonic-3.5-2026-05-04",
      "sonic-3",
      "sonic-3-2026-01-12",
      "sonic-3-2025-10-27",
      "sonic-2",
      "sonic-2-2025-06-11",
      "sonic-multilingual",
      "sonic-english",
      "sonic-preview",
      "sonic",
    ],
    defaultModel: "sonic-3.6",
    speed: [0.6, 1.5],
    stability: false,
    modelHint: "sonic-3.6 הוא מה שהקולות הקיימים משתמשים בו.",
  },
};

export function isVoiceProvider(value: string): value is VoiceProvider {
  return value === "11labs" || value === "cartesia";
}

export function providerLabel(provider: string): string {
  return isVoiceProvider(provider) ? PROVIDERS[provider].label : provider;
}
