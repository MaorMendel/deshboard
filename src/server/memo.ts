// זיכרון קצר-טווח בתוך התהליך, לרשימות מ-Vapi שמשמשות את תפריטי הבחירה בפאנל הניהול.
//
// חשוב: לא לשמור כאן תשובה שמוצגת למשתמש וחוזרת אלינו בעדכון הבא (למשל ההנחיות של assistant).
// תשובה ישנה כזו נשלחת בחזרה ל-Vapi ודורסת שינוי שנעשה בינתיים. בדיוק זה קרה כשההנחיות
// נשמרו בזיכרון: הדף הציג פרומפט ישן, והעדכון הבא דרס את החדש.
// הזיכרון הזה הוא פר-תהליך, ולכן גם אי אפשר לסמוך על ניקוי שלו מתוך בקשה אחרת.

interface Entry {
  at: number;
  value: unknown;
}

const store = new Map<string, Entry>();

/** רשימות שמשתנות רק כשמוסיפים assistant או מספר ב-Vapi */
export const VAPI_LISTS_TTL_MS = 5 * 60_000;

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  store.set(key, { at: Date.now(), value });
  return value;
}
