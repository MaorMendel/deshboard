// מה השתנה בין שתי גרסאות של בוט, במילים. משמש את היסטוריית הגרסאות בפאנל.

import type { BotSettings } from "./types";

const SPEAKER = { bot: "הבוט", caller: "המתקשר" } as const;

function textChange(label: string, before: string, after: string): string | null {
  const a = before.trim();
  const b = after.trim();
  if (a === b) return null;
  if (!a) return `${label} נוסף`;
  if (!b) return `${label} נמחק`;
  return label;
}

/**
 * רשימה קצרה של מה שהשתנה, למשל ["קול: נועה ← איתי", "פתיח", "הנחיות (+240 תווים)"].
 * prev = null: זו הגרסה הראשונה.
 */
export function describeChanges(
  prev: BotSettings | null,
  next: BotSettings,
  voiceName: (voiceId: string) => string,
): string[] {
  if (!prev) return ["גרסה ראשונה"];
  const changes: string[] = [];
  if (prev.voiceId !== next.voiceId) changes.push(`קול: ${voiceName(prev.voiceId)} ← ${voiceName(next.voiceId)}`);
  if (prev.firstSpeaker !== next.firstSpeaker) {
    changes.push(`מי מדבר ראשון: ${SPEAKER[prev.firstSpeaker]} ← ${SPEAKER[next.firstSpeaker]}`);
  }
  const opening = textChange("פתיח", prev.openingMessage, next.openingMessage);
  if (opening) changes.push(opening);
  const closing = textChange("משפט סיום", prev.closingMessage, next.closingMessage);
  if (closing) changes.push(closing);

  const a = (prev.prompt ?? "").trim();
  const b = (next.prompt ?? "").trim();
  // גרסה בלי הנחיות לא אומרת שההנחיות נמחקו: ריק = "לא נוגעים". לכן רק תוספת או שינוי נספרים.
  if (b && a !== b) {
    if (!a) changes.push("הנחיות נשמרו");
    else {
      const delta = b.length - a.length;
      changes.push(delta === 0 ? "הנחיות" : `הנחיות (${delta > 0 ? "+" : "−"}${Math.abs(delta).toLocaleString("he-IL")} תווים)`);
    }
  }
  return changes.length ? changes : ["בלי שינוי"];
}
