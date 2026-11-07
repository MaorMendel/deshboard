// האם כל המיגרציות שבקוד כבר הורצו על ה-DB. כשעדכון מוסיף מיגרציה ושוכחים להריץ npm run db:migrate,
// קוד חדש פונה לעמודות וטבלאות שעוד לא קיימות. עדיף להגיד את זה בפאנל מאשר לגלות מעמוד שקורס.

import { sql } from "drizzle-orm";
import journal from "../../drizzle/meta/_journal.json";
import { getDb } from "@/db";

/**
 * כמה מיגרציות מהקוד עוד לא הורצו. null כשאי אפשר לדעת: למשל אם ה-DB הוקם בלי npm run db:migrate,
 * ואז אין לו את טבלת המעקב של drizzle. באותה השוואה ש-drizzle עצמו עושה: לפי זמן היצירה של כל מיגרציה.
 */
export async function pendingMigrations(): Promise<number | null> {
  try {
    const result = await getDb().execute(sql`select max(created_at) as last from drizzle.__drizzle_migrations`);
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { last: string | null }[];
    const last = Number(rows[0]?.last ?? 0);
    return journal.entries.filter((e) => e.when > last).length;
  } catch {
    return null;
  }
}
