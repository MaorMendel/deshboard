import { timingSafeEqual } from "node:crypto";
import { config } from "./config";

/**
 * בודק את הסוד המשותף של ה-API הפנימי.
 * המערכת הראשית שולחת: Authorization: Bearer <INTERNAL_API_SECRET>
 * מחזיר תשובת שגיאה אם אין הרשאה, או null אם הכול תקין.
 */
export function checkInternalAuth(request: Request): Response | null {
  const secret = config.internalApiSecret();
  if (secret.length < 16) {
    return Response.json({ error: "INTERNAL_API_SECRET לא מוגדר בשרת (לפחות 16 תווים)." }, { status: 503 });
  }
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
