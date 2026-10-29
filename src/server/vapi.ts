// ההמרה בין ההגדרות של המסך לשדות של assistant ב-Vapi, לשני הכיוונים.

import type { BotSettings } from "@/lib/types";
import type { VoiceRow } from "@/db/schema";
import type { AssistantFields, VapiAssistant, VapiModel, VapiVoice } from "./vapi-client";

/**
 * אובייקט ה-voice שנשלח ל-Vapi.
 * Vapi מחליף את כל אובייקט ה-voice בעדכון, ולכן שולחים אותו מלא:
 * 1. אם יש לקול הגדרות מלאות שיובאו מ-Vapi, משתמשים בהן.
 * 2. אחרת, אם ה-assistant כבר משתמש באותו ספק, שומרים את הכיוונונים שלו ומחליפים רק את ה-voiceId.
 * 3. אחרת, רק ספק ו-voiceId.
 */
export function buildVoice(voice: VoiceRow, current?: VapiVoice): VapiVoice {
  if (voice.providerConfig) {
    return { ...voice.providerConfig, provider: voice.provider, voiceId: voice.providerVoiceId };
  }
  if (current && current.provider === voice.provider) {
    return { ...current, voiceId: voice.providerVoiceId };
  }
  return { provider: voice.provider, voiceId: voice.providerVoiceId };
}

/**
 * השדות שהמסך שולט בהם. בעדכון הבוט נשלחים ב-PATCH, ובשיחת ניסיון כ-assistantOverrides.
 *
 * פתיח ריק כשהבוט מדבר ראשון: Vapi מקבל `assistant-speaks-first-with-model-generated-message`,
 * ואז הבוט פותח במשפט שהמודל מחבר לפי ההנחיות, במקום לשתוק או לומר משפט קבוע.
 */
export function toAssistantFields(settings: BotSettings, voice: VapiVoice): AssistantFields {
  return {
    voice,
    ...firstMessageFields(settings),
    // השדה הזה לא מקבל null ב-Vapi. מחרוזת ריקה מנקה אותו.
    endCallMessage: settings.closingMessage,
  };
}

/** "מי מדבר ראשון" והפתיח הולכים יחד, כי המצב נגזר משניהם */
export function firstMessageFields(settings: BotSettings): Pick<AssistantFields, "firstMessage" | "firstMessageMode"> {
  const opening = settings.openingMessage.trim();
  return {
    firstMessageMode:
      settings.firstSpeaker !== "bot"
        ? "assistant-waits-for-user"
        : opening
          ? "assistant-speaks-first"
          : "assistant-speaks-first-with-model-generated-message",
    firstMessage: settings.openingMessage,
  };
}

/** הפרומפט של assistant: התוכן של הודעת ה-system */
export function promptFromModel(model: VapiModel | undefined): string {
  const system = model?.messages?.find((m) => m.role === "system");
  return typeof system?.content === "string" ? system.content : "";
}

/**
 * ה-model עם הפרומפט החדש. רק התוכן של הודעת ה-system מוחלף.
 * Vapi מחליף את כל אובייקט ה-model בעדכון, ולכן מחזירים אותו בשלמותו,
 * כדי שהמודל, הטמפרטורה, הכלים ושאר ההודעות לא ייפגעו.
 */
export function modelWithPrompt(model: VapiModel, prompt: string): VapiModel {
  const messages = [...(model.messages ?? [])];
  const index = messages.findIndex((m) => m.role === "system");
  if (index >= 0) messages[index] = { ...messages[index], content: prompt };
  else messages.unshift({ role: "system", content: prompt });
  return { ...model, messages };
}

/** קריאת ההגדרות הנוכחיות מ-assistant קיים, כשמחברים לקוח קיים למערכת */
export function settingsFromAssistant(assistant: VapiAssistant, voiceId: string): BotSettings {
  return {
    voiceId,
    firstSpeaker: assistant.firstMessageMode === "assistant-waits-for-user" ? "caller" : "bot",
    openingMessage: assistant.firstMessage ?? "",
    closingMessage: assistant.endCallMessage ?? "",
    prompt: promptFromModel(assistant.model),
  };
}
