// הכניסה לפאנל הניהול: סיסמה אחת (ADMIN_PASSWORD) ועוגיית session.
// ערך העוגייה נגזר מהסיסמה, כך שהחלפת הסיסמה מנתקת מיד את כל מי שמחובר.

import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { config } from "./config";

export const ADMIN_COOKIE = "admin_session";
const SESSION_DAYS = 30;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** מה שנשמר בעוגייה. לא הסיסמה עצמה. */
function sessionToken(): string {
  return createHash("sha256").update(`bot-dashboard-admin:${config.adminPassword()}`).digest("hex");
}

export function adminConfigured(): boolean {
  return config.adminPassword().length >= 8;
}

export function passwordOk(given: string): boolean {
  if (!adminConfigured()) return false;
  return timingSafeEqual(digest(given), digest(config.adminPassword()));
}

/**
 * האם הבקשה הנוכחית היא של אדמין מחובר. רץ רק בזמן בקשה (בתוך Suspense או action).
 * חשוב: cookies() נקרא ראשון. אם בודקים את הסיסמה לפני, ב-build בלי ADMIN_PASSWORD
 * הפונקציה מסיימת בלי לגעת בבקשה, והתוצאה (הפניה לדף הכניסה) נאפית לתוך הדף הסטטי.
 */
export async function isAdmin(): Promise<boolean> {
  const value = (await cookies()).get(ADMIN_COOKIE)?.value ?? "";
  if (!adminConfigured()) return false;
  return timingSafeEqual(digest(value), digest(sessionToken()));
}

/** נקרא מ-server action אחרי בדיקת הסיסמה */
export async function setAdminSession(): Promise<void> {
  (await cookies()).set(ADMIN_COOKIE, sessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function clearAdminSession(): Promise<void> {
  (await cookies()).delete(ADMIN_COOKIE);
}
