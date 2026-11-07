// היסטוריית הגרסאות של בוט, והחזרה לגרסה קודמת. משמש את פאנל הניהול בלבד.
//
// כל "עדכן את הבוט" של לקוח, וכל עריכת הנחיות מהפאנל, שומרים גרסה מלאה ב-bot_versions.
// שחזור לא מוחק כלום: הוא יוצר גרסה חדשה עם ההגדרות הישנות ושולח אותן ל-Vapi, ולכן גם אותו אפשר לבטל.
// מה שלא נשמר כאן: שינויים שנעשו ישירות ב-Vapi, והגדרות שהדשבורד לא שולט בהן (מודל, כלים וכו').

import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { accessLinks, auditLog, botVersions, tenants, voices, type Tenant } from "@/db/schema";
import type { BotSettings } from "@/lib/types";
import { normalizeSettings } from "@/lib/validation";
import { ServiceError } from "./errors";
import { buildVoice, firstMessageFields, modelWithPrompt, promptFromModel } from "./vapi";
import { isVapiConfigured, vapi, VapiError, type AssistantFields } from "./vapi-client";

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** מכניס גרסה חדשה (המספר הבא) והופך אותה לגרסה הפעילה. בתוך טרנזקציה. */
export async function insertVersion(
  tx: Tx,
  tenantId: string,
  settings: BotSettings,
  meta: { byType: "link" | "admin"; linkId?: string | null; vapiPayload?: Record<string, unknown> | null },
) {
  const [{ next }] = await tx
    .select({ next: sql<number>`coalesce(max(${botVersions.version}), 0) + 1` })
    .from(botVersions)
    .where(eq(botVersions.tenantId, tenantId));
  const [version] = await tx
    .insert(botVersions)
    .values({
      tenantId,
      version: Number(next),
      settings,
      vapiPayload: meta.vapiPayload ?? null,
      createdByType: meta.byType,
      createdByLinkId: meta.linkId ?? null,
    })
    .returning();
  await tx.update(tenants).set({ currentVersionId: version.id }).where(eq(tenants.id, tenantId));
  return version;
}

export interface VersionEntry {
  id: string;
  version: number;
  createdAt: Date;
  settings: BotSettings;
  /** מי שמר: הלקוח (דרך הקישור שלו) או אדמין מהפאנל */
  by: "link" | "admin" | "system";
  /** השם של הקישור, כששמר לקוח */
  linkLabel: string | null;
  /** אם הגרסה נוצרה משחזור: מאיזו גרסה */
  restoredFrom: number | null;
  /** הגרסה הפעילה עכשיו */
  current: boolean;
}

export interface VersionHistory {
  /** מהחדשה לישנה */
  versions: VersionEntry[];
  /** ההגדרות של הגרסה שלפני הישנה ביותר ברשימה, כדי להראות גם מה היא שינתה. null אם היא הראשונה. */
  beforeOldest: BotSettings | null;
  /** האם יש עוד גרסאות ישנות שלא הוצגו */
  more: boolean;
  /** שמות הקולות לפי המזהה, כולל קולות כבויים */
  voiceNames: Record<string, string>;
  /** הקולות שכבויים כרגע בקטלוג */
  inactiveVoices: string[];
}

/** הגרסאות של לקוח, מהחדשה לישנה */
export async function listVersions(tenant: Tenant, limit = 30): Promise<VersionHistory> {
  const db = getDb();
  const rows = await db
    .select({
      id: botVersions.id,
      version: botVersions.version,
      createdAt: botVersions.createdAt,
      settings: botVersions.settings,
      by: botVersions.createdByType,
      linkLabel: accessLinks.label,
    })
    .from(botVersions)
    .leftJoin(accessLinks, eq(accessLinks.id, botVersions.createdByLinkId))
    .where(eq(botVersions.tenantId, tenant.id))
    .orderBy(desc(botVersions.version))
    // אחת יותר: כדי לדעת אם יש עוד, וכדי להשוות את הישנה שמוצגת לגרסה שלפניה
    .limit(limit + 1);

  const [restores, voiceRows] = await Promise.all([
    db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.id), eq(auditLog.action, "bot.restore"))),
    db.select({ id: voices.id, name: voices.name, isActive: voices.isActive }).from(voices),
  ]);
  const restoredFrom = new Map<string, number>();
  for (const r of restores) {
    const after = r.after as { versionId?: string; restoredFromVersion?: number } | null;
    if (after?.versionId && after.restoredFromVersion) restoredFrom.set(after.versionId, after.restoredFromVersion);
  }

  return {
    versions: rows.slice(0, limit).map((r) => ({
      ...r,
      restoredFrom: restoredFrom.get(r.id) ?? null,
      current: r.id === tenant.currentVersionId,
    })),
    beforeOldest: rows[limit]?.settings ?? null,
    more: rows.length > limit,
    voiceNames: Object.fromEntries(voiceRows.map((v) => [v.id, v.name])),
    inactiveVoices: voiceRows.filter((v) => !v.isActive).map((v) => v.id),
  };
}

/**
 * מחזיר את הבוט להגדרות של גרסה קודמת: קול, מי מדבר ראשון, פתיח, סגירה והנחיות.
 * יוצר גרסה חדשה, ואצל לקוח משלם שולח את כל השדות האלה ל-Vapi (הקול נבנה מהקטלוג, כמו בכל שמירה).
 * גרסה ישנה בלי הנחיות: ההנחיות הנוכחיות נשארות כמו שהן.
 */
export async function restoreVersion(tenant: Tenant, versionId: string) {
  const db = getDb();
  const [target] = await db
    .select()
    .from(botVersions)
    .where(and(eq(botVersions.id, versionId), eq(botVersions.tenantId, tenant.id)));
  if (!target) throw new ServiceError("validation", "הגרסה לא נמצאה.");
  if (target.id === tenant.currentVersionId) throw new ServiceError("validation", "זו כבר הגרסה הפעילה.");

  const [voice] = await db.select().from(voices).where(eq(voices.id, target.settings.voiceId));
  if (!voice) throw new ServiceError("validation", "הקול של הגרסה הזו כבר לא קיים בקטלוג, ולכן אי אפשר לשחזר אותה.");

  const isCustomer = tenant.type === "customer";
  if (isCustomer && (!tenant.vapiAssistantId || !isVapiConfigured())) {
    throw new ServiceError("not_configured", "הלקוח לא מחובר ל-assistant ב-Vapi.");
  }

  const [current] = tenant.currentVersionId
    ? await db.select().from(botVersions).where(eq(botVersions.id, tenant.currentVersionId))
    : [];

  const created = await db.transaction(async (tx) => {
    let settings = normalizeSettings(target.settings);
    let payload: Record<string, unknown> | null = null;

    if (isCustomer) {
      try {
        // ה-assistant נקרא טרי: את ה-model שולחים בחזרה בשלמותו, רק עם ההנחיות המוחלפות
        const assistant = await vapi.getAssistant(tenant.vapiAssistantId!);
        const livePrompt = promptFromModel(assistant.model);
        if (!settings.prompt) settings = { ...settings, prompt: livePrompt };

        const fields: AssistantFields = {
          voice: buildVoice(voice, assistant.voice),
          ...firstMessageFields(settings),
          endCallMessage: settings.closingMessage,
        };
        if (settings.prompt && settings.prompt !== livePrompt && assistant.model) {
          fields.model = modelWithPrompt(assistant.model, settings.prompt);
        }
        await vapi.updateAssistant(tenant.vapiAssistantId!, fields);
        payload = fields as Record<string, unknown>;
      } catch (err) {
        if (err instanceof VapiError) {
          console.error("Vapi error on restore:", err.status, err.message);
          throw new ServiceError("vapi_error", "Vapi לא קיבל את העדכון. שום דבר לא השתנה, אפשר לנסות שוב.");
        }
        throw err;
      }
    } else if (!settings.prompt) {
      settings = { ...settings, prompt: (current?.settings.prompt ?? "").trim() };
    }

    const version = await insertVersion(tx, tenant.id, settings, { byType: "admin", vapiPayload: payload });
    await tx.insert(auditLog).values({
      tenantId: tenant.id,
      actorType: "admin",
      action: "bot.restore",
      before: current?.settings ?? null,
      after: { versionId: version.id, restoredFromVersion: target.version, settings },
    });
    return version;
  });

  return { version: created.version, restoredFrom: target.version, voiceInactive: !voice.isActive };
}
