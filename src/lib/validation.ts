import type { BotSettings, FieldErrors } from "./types";

export const OPENING_MAX = 500;
export const CLOSING_MAX = 500;
/** המגבלה בפאנל הניהול */
export const PROMPT_MAX = 20_000;

/**
 * המגבלה ללקוח. הנחיות ארוכות נשלחות למודל בכל תור בשיחה, ולכן מייקרות כל דקה.
 * לקוח שכבר יש לו הנחיות ארוכות יותר (כי אדמין כתב אותן) יכול להמשיך לערוך אותן, אבל לא להאריך מעבר לזה.
 */
export const CUSTOMER_PROMPT_MAX = 8_000;

/** כמה תווים מותר ללקוח, לפי אורך ההנחיות שיש לבוט שלו עכשיו */
export function customerPromptLimit(currentLength: number): number {
  return Math.max(CUSTOMER_PROMPT_MAX, currentLength);
}

// הערה: Vapi מפרש {{ ... }} כמשתנים (Liquid). לא חוסמים אותם, כי assistants קיימים
// עשויים להשתמש במשתנים שהמערכת הראשית ממלאת.

/**
 * אותה ולידציה רצה בדפדפן (לתגובה מיידית) ובשרת (כי לדפדפן אסור לסמוך).
 */
export function validateSettings(
  settings: BotSettings,
  knownVoiceIds: string[],
  promptMax: number = CUSTOMER_PROMPT_MAX,
): FieldErrors {
  const errors: FieldErrors = {};
  const opening = settings.openingMessage.trim();
  const closing = settings.closingMessage.trim();

  if (!knownVoiceIds.includes(settings.voiceId)) {
    errors.voiceId = "צריך לבחור קול מהרשימה.";
  }

  if (settings.firstSpeaker !== "bot" && settings.firstSpeaker !== "caller") {
    errors.firstSpeaker = "צריך לבחור מי מדבר ראשון.";
  }

  // פתיח ריק מותר: הבוט פותח במשפט שהוא מחבר לפי ההנחיות
  if (opening.length > OPENING_MAX) {
    errors.openingMessage = `הפתיח ארוך מדי. אפשר עד ${OPENING_MAX} תווים.`;
  }

  if (closing.length > CLOSING_MAX) {
    errors.closingMessage = `הסגירה ארוכה מדי. אפשר עד ${CLOSING_MAX} תווים.`;
  }

  if ((settings.prompt ?? "").trim().length > promptMax) {
    errors.prompt = `ההנחיות ארוכות מדי. אפשר עד ${promptMax.toLocaleString("he-IL")} תווים.`;
  }

  return errors;
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function normalizeSettings(settings: BotSettings): BotSettings {
  return {
    voiceId: settings.voiceId,
    firstSpeaker: settings.firstSpeaker,
    openingMessage: settings.openingMessage.trim(),
    closingMessage: settings.closingMessage.trim(),
    prompt: (settings.prompt ?? "").trim(),
  };
}

export function sameSettings(a: BotSettings, b: BotSettings): boolean {
  return (
    a.voiceId === b.voiceId &&
    a.firstSpeaker === b.firstSpeaker &&
    a.openingMessage.trim() === b.openingMessage.trim() &&
    a.closingMessage.trim() === b.closingMessage.trim() &&
    (a.prompt ?? "").trim() === (b.prompt ?? "").trim()
  );
}
