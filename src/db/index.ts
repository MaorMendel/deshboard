import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema";

/** כל חיבור ל-DB (Postgres אמיתי או PGlite בבדיקות) עונה על הטיפוס הזה */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

// ב-dev, hot reload טוען את המודול מחדש. שומרים חיבור אחד על globalThis כדי לא לפתוח חיבורים בלי סוף.
const globalForDb = globalThis as unknown as { __pgClient?: ReturnType<typeof postgres>; __db?: Db };

function getClient() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL לא מוגדר. צריך להעתיק את .env.example ל-.env ולמלא אותו.");
  // prepare: false - ה-Pooler של Supabase עובד במצב transaction, שלא תומך ב-prepared statements
  const max = Number(process.env.DATABASE_POOL_MAX ?? 10);
  return (globalForDb.__pgClient ??= postgres(url, { max, prepare: false }));
}

/** החיבור ל-DB. נוצר רק בשימוש הראשון, כדי ש-build לא ידרוש DATABASE_URL. */
export function getDb(): Db {
  return (globalForDb.__db ??= drizzle(getClient(), { schema }));
}

/** לבדיקות בלבד: מחליף את החיבור ב-DB אחר (למשל PGlite בזיכרון) */
export function setDbForTests(db: Db) {
  globalForDb.__db = db;
}

export { schema };
