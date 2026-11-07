// הסכמה של ה-DB. כל שינוי כאן -> npm run db:generate -> קובץ מיגרציה חדש בתיקיית drizzle/.
//
// עקרונות:
// - לכל טבלה שקשורה ללקוח יש tenant_id, וכל שאילתה עוברת דרך שכבת השירות.
// - ה-DB משרת רק את ממשק הבוט. חבילות וחיוב נמצאים במערכת הראשית, והקישור אליה הוא external_customer_id.
// - לקוחות לא נמחקים. משעים אותם (status = 'suspended'), כי השיחות שלהם הן הבסיס לחישוב הדקות.
// - זמנים ב-timestamptz, עלות ב-numeric, טלפונים בפורמט E.164.

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { BotSettings } from "../lib/types";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** bytea. לקבצים קטנים שנשמרים ב-DB, כמו דוגמאות השמע של הקולות. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
const E164 = sql`'^\\+[1-9][0-9]{7,14}$'`;

// ---------- enums ----------

export const tenantType = pgEnum("tenant_type", ["customer", "demo"]);
export const tenantStatus = pgEnum("tenant_status", ["active", "suspended"]);
export const voiceGender = pgEnum("voice_gender", ["female", "male"]);
export const voiceTier = pgEnum("voice_tier", ["standard", "premium"]);
export const callType = pgEnum("call_type", ["inbound", "outbound", "test"]);
export const callStatus = pgEnum("call_status", ["queued", "in_progress", "ended", "failed"]);
export const actorType = pgEnum("actor_type", ["link", "admin", "system"]);

// ---------- tenants: העסקים (לקוחות משלמים ודמואים) ----------

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** מזהה הלקוח ב-DB של המערכת הראשית (שם נמצאים החבילה והחיוב). ריק בדמו עד שהוא הופך ללקוח. */
    externalCustomerId: text("external_customer_id").unique(),
    /** שם לתצוגה במסך */
    name: text("name").notNull(),
    type: tenantType("type").notNull().default("customer"),
    /** האם הקישורים של הלקוח עובדים */
    status: tenantStatus("status").notNull().default("active"),

    /** מגבלת השניות של דמו (300 = 5 דקות). חובה בדמו, null אצל לקוח. */
    demoSecondsLimit: integer("demo_seconds_limit"),
    demoExpiresAt: timestamp("demo_expires_at", { withTimezone: true }),

    /** ה-assistant החי ב-Vapi. null בדמו: דמואים משתמשים ב-assistant בסיס משותף. */
    vapiAssistantId: text("vapi_assistant_id"),
    /** המספר שהבוט עונה בו ב-Vapi. null בדמו. */
    vapiPhoneNumberId: text("vapi_phone_number_id"),
    botPhoneDisplay: text("bot_phone_display"),

    /** המספר ש"נסה את הבוט" מתקשר אליו. רק אדמין משנה אותו. */
    verifiedPhone: text("verified_phone"),

    /** תחילת החבילה. ממנה נספר מחזור חודשי (אותו יום בחודש). null = עוד לא הוגדרה חבילה. */
    planStartedAt: timestamp("plan_started_at", { withTimezone: true }),
    /** גודל החבילה בדקות לחודש, לתצוגה ללקוח ולאדמין. החיוב עצמו נשאר במערכת הראשית. */
    planMinutes: integer("plan_minutes"),

    /** הגרסה שהבוט עובד איתה עכשיו */
    currentVersionId: uuid("current_version_id").references((): AnyPgColumn => botVersions.id, {
      onDelete: "set null",
    }),

    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check(
      "tenants_demo_fields",
      sql`${t.type} <> 'demo' or (${t.demoSecondsLimit} is not null and ${t.demoExpiresAt} is not null)`,
    ),
    check("tenants_verified_phone_e164", sql`${t.verifiedPhone} is null or ${t.verifiedPhone} ~ ${E164}`),
  ],
);

// ---------- bot_versions: כל עדכון של בוט. שורות לא נערכות ולא נמחקות. ----------

export const botVersions = pgTable(
  "bot_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** מה שהלקוח הגדיר במסך */
    settings: jsonb("settings").$type<BotSettings>().notNull(),
    /** מה שנשלח בפועל ל-Vapi. null כשלא נשלח כלום (למשל בדמו). */
    vapiPayload: jsonb("vapi_payload").$type<Record<string, unknown>>(),
    createdByType: actorType("created_by_type").notNull(),
    createdByLinkId: uuid("created_by_link_id").references(() => accessLinks.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("bot_versions_tenant_version").on(t.tenantId, t.version)],
);

// ---------- voices: קטלוג הקולות ----------

export const voices = pgTable("voices", {
  /** slug קבוע, למשל "noa". נשמר בתוך settings של הגרסאות, ולכן לא משנים אותו. */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  gender: voiceGender("gender").notNull(),
  description: text("description").notNull(),
  provider: text("provider").notNull(),
  providerVoiceId: text("provider_voice_id").notNull(),
  /**
   * אובייקט ה-voice המלא כפי שהוא מוגדר ב-Vapi (מודל, שפה, speed, volume וכו').
   * מיובא מה-assistants הקיימים, כדי שהחלפת קול לא תמחק את הכיוונונים.
   */
  providerConfig: jsonb("provider_config").$type<Record<string, unknown>>(),
  /**
   * הכתובת שממנה הדפדפן משמיע את הדוגמה. ברירת המחדל היא ה-route שמגיש את sample_audio,
   * אבל אפשר לשים כאן גם כתובת חיצונית לקובץ משלך.
   */
  sampleUrl: text("sample_url"),
  /**
   * קובץ ה-mp3 של הדוגמה, בתוך ה-DB ולא בדיסק: כך הוא זמין מיד אחרי היצירה,
   * גם בלי הפעלה מחדש של השרת, וגם כשמריצים את הפקודה מהמחשב מול DB בפרודקשן.
   */
  sampleAudio: bytea("sample_audio"),
  sampleUpdatedAt: timestamp("sample_updated_at", { withTimezone: true }),
  tier: voiceTier("tier").notNull().default("standard"),
  /** קולות לא נמחקים, רק מסומנים כלא פעילים, כי גרסאות ישנות מצביעות עליהם */
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
});

// ---------- access_links: הקישורים הייחודיים ----------

export const accessLinks = pgTable(
  "access_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** sha256 של המפתח שב-URL. לפי זה מחפשים את הקישור. */
    tokenHash: text("token_hash").notNull().unique(),
    /**
     * המפתח מוצפן (AES-256-GCM, המפתח נגזר מ-INTERNAL_API_SECRET), כדי שפאנל הניהול
     * יוכל להציג קישור קיים. null בקישורים שנוצרו לפני, או כשאין סוד בשרת.
     */
    tokenEncrypted: text("token_encrypted"),
    /** למי הקישור שייך, למשל "רוני" או "המזכירה" */
    label: text("label").notNull(),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("access_links_tenant").on(t.tenantId)],
);

// ---------- calls: כל שיחה, אמיתית או ניסיון. מכאן המערכת הראשית מקבלת את הדקות. ----------

// ---------- sync_state: עד איפה השיחות מסונכרנות מ-Vapi ----------

/**
 * לכל לקוח (ול-assistant המשותף של הדמואים): מתי הסתיים הסנכרון האחרון, ומאיזה רגע השיחות אצלנו שלמות.
 * בזכות זה כל סנכרון מושך מ-Vapi רק מה שהשתנה מאז הקודם, במקום את כל החודש מחדש.
 */
export const syncState = pgTable("sync_state", {
  /** "tenant:<id>" או "demo-assistant" */
  key: text("key").primaryKey(),
  /** כל שיחה שהשתנתה מהרגע הזה ועד synced_at כבר אצלנו */
  coveredFrom: timestamp("covered_from", { withTimezone: true }).notNull(),
  /** מתי התחיל הסנכרון האחרון שהצליח */
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
});

/**
 * הפירוט של העלות כפי ש-Vapi מחזיר אותו (Call.costBreakdown), בדולרים.
 * נשמר כמו שהוא, כדי שאפשר יהיה להציג בפאנל כמה הלך על כל רכיב.
 */
export interface CallCostBreakdown {
  /** טלפוניה: Twilio, Vonage וכו' */
  transport?: number;
  /** תמלול הדיבור (speech-to-text) */
  stt?: number;
  /** מודל השפה */
  llm?: number;
  /** הקול (text-to-speech) */
  tts?: number;
  /** העמלה של Vapi עצמו */
  vapi?: number;
  chat?: number;
  total?: number;
  llmPromptTokens?: number;
  llmCompletionTokens?: number;
  llmCachedPromptTokens?: number;
  ttsCharacters?: number;
  /** ניתוח אחרי השיחה: סיכום, נתונים מובנים, הערכת הצלחה */
  analysisCostBreakdown?: {
    summary?: number;
    structuredData?: number;
    successEvaluation?: number;
    structuredOutput?: number;
    [key: string]: number | undefined;
  };
}

export const calls = pgTable(
  "calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    /** null עד ש-Vapi מחזיר מזהה (בשיחת ניסיון השורה נוצרת לפני הקריאה ל-Vapi) */
    vapiCallId: text("vapi_call_id").unique(),
    type: callType("type").notNull(),
    status: callStatus("status").notNull().default("queued"),
    vapiAssistantId: text("vapi_assistant_id"),
    /** המספר של מי שהתקשר (נכנסת) או שאליו התקשרו (יוצאת וניסיון) */
    customerNumber: text("customer_number"),

    /** הגרסה שהייתה חיה בזמן השיחה */
    versionId: uuid("version_id").references(() => botVersions.id, { onDelete: "set null" }),
    /** בשיחת ניסיון: ההגדרות שעל המסך, שאולי עוד לא עודכנו */
    testSettings: jsonb("test_settings").$type<BotSettings>(),

    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    /** מה ש-Vapi חייב אותך על השיחה */
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }),
    /** על מה הלך הכסף: מודל, קול, תמלול, טלפוניה, Vapi */
    costBreakdown: jsonb("cost_breakdown").$type<CallCostBreakdown>(),
    endedReason: text("ended_reason"),

    summary: text("summary"),
    transcript: text("transcript"),
    recordingUrl: text("recording_url"),
    /** ה-end-of-call-report המלא, לדיבוג */
    raw: jsonb("raw").$type<Record<string, unknown>>(),

    createdAt: createdAt(),
  },
  (t) => [
    index("calls_tenant_started").on(t.tenantId, t.startedAt),
    index("calls_tenant_created").on(t.tenantId, t.createdAt),
    // שיחת ניסיון פעילה אחת לכל לקוח בכל רגע. נאכף ב-DB, כך ששתי לחיצות במקביל לא עוברות.
    uniqueIndex("calls_one_active_test")
      .on(t.tenantId)
      .where(sql`${t.type} = 'test' and ${t.status} in ('queued', 'in_progress')`),
    check("calls_duration_non_negative", sql`${t.durationSeconds} is null or ${t.durationSeconds} >= 0`),
  ],
);

// ---------- audit_log: כל פעולה במערכת ----------

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** null בפעולות אדמין שלא קשורות ללקוח מסוים */
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "restrict" }),
    actorType: actorType("actor_type").notNull(),
    actorLinkId: uuid("actor_link_id").references(() => accessLinks.id, { onDelete: "set null" }),
    /** למשל bot.update, test_call.start, link.create, link.revoke, tenant.suspend, demo.convert */
    action: text("action").notNull(),
    before: jsonb("before").$type<unknown>(),
    after: jsonb("after").$type<unknown>(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_tenant_created").on(t.tenantId, t.createdAt)],
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type BotVersion = typeof botVersions.$inferSelect;
export type VoiceRow = typeof voices.$inferSelect;
export type AccessLink = typeof accessLinks.$inferSelect;
export type Call = typeof calls.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
