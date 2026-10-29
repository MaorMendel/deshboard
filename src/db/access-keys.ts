import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "@/server/config";

/** מפתח חדש לקישור ייחודי: 32 בתים אקראיים, 43 תווים ב-URL. אי אפשר לנחש אותו. */
export function generateAccessKey(): string {
  return randomBytes(32).toString("base64url");
}

/** לפי זה מחפשים את הקישור ב-DB. חד-כיווני. */
export function hashAccessKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// ---------- העותק המוצפן, כדי שפאנל הניהול יוכל להציג קישור קיים ----------
// המפתח להצפנה נגזר מ-INTERNAL_API_SECRET, שנמצא רק בשרת. מי שמשיג גישה ל-DB לבד
// לא יכול לפתוח את הקישורים. אם הסוד מתחלף, קישורים קיימים ממשיכים לעבוד אבל לא ניתן להציג אותם.

const CIPHER = "aes-256-gcm";

function encryptionKey(): Buffer | null {
  const secret = config.internalApiSecret();
  if (secret.length < 16) return null;
  return createHash("sha256").update(`bot-dashboard-link-v1:${secret}`).digest();
}

/** null כשאין סוד בשרת. אז פשוט לא נשמר עותק, והכול עובד חוץ מההצגה בפאנל. */
export function encryptAccessKey(key: string): string | null {
  const secret = encryptionKey();
  if (!secret) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, secret, iv);
  const data = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return ["v1", iv, data, cipher.getAuthTag()].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/** null אם אין עותק, אם הסוד התחלף, או אם הערך נפגם */
export function decryptAccessKey(stored: string | null | undefined): string | null {
  const secret = encryptionKey();
  if (!stored || !secret) return null;
  const [version, iv, data, tag] = stored.split(".");
  if (version !== "v1" || !iv || !data || !tag) return null;
  try {
    const decipher = createDecipheriv(CIPHER, secret, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
