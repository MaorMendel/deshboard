// פאנל הניהול: מה זה "מהיר" ו"סבלני" לכל הלקוחות ולכל לקוח, והחלה של השינויים על ה-assistants ב-Vapi.

import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, botVersions, tenants, type Tenant } from "@/db/schema";
import type { ResponseStyle } from "@/lib/conversation-style";
import { ServiceError } from "./errors";
import {
  presetsForTenant,
  saveGlobalPresets,
  saveTenantPresets,
  tenantOverrides,
  timingFields,
  type PresetsForTenant,
  type TimingPresets,
} from "./conversation-style";
import { isVapiConfigured, vapi, VapiError } from "./vapi-client";

export interface ApplyResult {
  updated: string[];
  failed: string[];
  /** הערות לפי לקוח: ספק תמלול לא נתמך, ערך שנחתך */
  notes: string[];
}

/**
 * מעדכן ב-Vapi את קצב המענה של לקוחות שכבר בחרו קצב. לקוח שלא בחר לא משתנה.
 * only: רק את הלקוחות האלה. skip: לא לגעת בקצב מסוים אצל לקוח (כי יש לו ערכים משלו).
 */
async function applyToTenants(opts: {
  only?: string[];
  skip?: (tenantId: string, style: ResponseStyle) => boolean;
}): Promise<ApplyResult> {
  const result: ApplyResult = { updated: [], failed: [], notes: [] };
  if (!isVapiConfigured()) return result;

  const rows = await getDb()
    .select({ id: tenants.id, name: tenants.name, assistantId: tenants.vapiAssistantId, settings: botVersions.settings })
    .from(tenants)
    .innerJoin(botVersions, eq(botVersions.id, tenants.currentVersionId))
    .where(and(eq(tenants.type, "customer"), isNotNull(tenants.vapiAssistantId)));

  // אחד אחרי השני, כדי לא להיתקל במגבלת הקצב של Vapi
  for (const t of rows) {
    const style = t.settings.responseStyle;
    if (!style) continue;
    if (opts.only && !opts.only.includes(t.id)) continue;
    if (opts.skip?.(t.id, style)) continue;
    try {
      const [assistant, presets] = await Promise.all([vapi.getAssistant(t.assistantId!), presetsForTenant(t.id)]);
      const timing = timingFields(assistant, presets.effective[style]);
      await vapi.updateAssistant(t.assistantId!, {
        startSpeakingPlan: timing.startSpeakingPlan,
        ...(timing.transcriber ? { transcriber: timing.transcriber } : {}),
      });
      result.updated.push(t.name);
      for (const note of timing.notes) result.notes.push(`${t.name}: ${note}`);
    } catch (err) {
      if (!(err instanceof VapiError)) throw err;
      console.error("apply timing failed:", t.id, err.status, err.message);
      result.failed.push(t.name);
    }
  }
  return result;
}

/** הערכים הכלליים, והחלה על כל הלקוחות שבחרו קצב ואין להם ערכים משלהם לאותו קצב */
export async function updateGlobalPresets(presets: TimingPresets): Promise<ApplyResult> {
  const saved = await saveGlobalPresets(presets);
  const overrides = await tenantOverrides();
  const result = await applyToTenants({ skip: (id, style) => Boolean(overrides.get(id)?.[style]) });
  await getDb()
    .insert(auditLog)
    .values({ actorType: "admin", action: "response_presets.global", after: { presets: saved, ...result } });
  return result;
}

/**
 * ערכים משלו ללקוח (null = חזרה לכלליים), והחלה עליו אם הוא כבר בחר קצב.
 * גם לדמו אפשר: אין לו assistant משלו, והערכים חלים על שיחות הניסיון שלו.
 */
export async function updateTenantPresets(tenant: Tenant, presets: Partial<TimingPresets> | null): Promise<ApplyResult> {
  await saveTenantPresets(tenant.id, presets);
  const result = await applyToTenants({ only: [tenant.id] });
  await getDb()
    .insert(auditLog)
    .values({ tenantId: tenant.id, actorType: "admin", action: "response_presets.tenant", after: { presets, ...result } });
  return result;
}

export interface TenantTimingInfo {
  presets: PresetsForTenant;
  /** מה הלקוח בחר בפעם האחרונה. null = עוד לא בחר */
  choice: ResponseStyle | null;
  /** ספק התמלול של ה-assistant, ומה יקרה עם End-of-Turn. null בדמו או כש-Vapi לא זמין. */
  live: { transcriber: string | null; notes: string[]; smartEndpointing: boolean } | null;
}

export async function tenantTimingInfo(tenant: Tenant): Promise<TenantTimingInfo> {
  const [presets, version] = await Promise.all([
    presetsForTenant(tenant.id),
    tenant.currentVersionId
      ? getDb().select({ settings: botVersions.settings }).from(botVersions).where(eq(botVersions.id, tenant.currentVersionId))
      : Promise.resolve([]),
  ]);
  const choice = version[0]?.settings.responseStyle ?? null;

  let live: TenantTimingInfo["live"] = null;
  if (tenant.type === "customer" && tenant.vapiAssistantId && isVapiConfigured()) {
    const assistant = await vapi.getAssistant(tenant.vapiAssistantId).catch(() => null);
    if (assistant) {
      const plan = assistant.startSpeakingPlan as Record<string, unknown> | undefined;
      const provider = (assistant.transcriber as Record<string, unknown> | undefined)?.provider;
      live = {
        transcriber: typeof provider === "string" ? provider : null,
        notes: timingFields(assistant, presets.effective[choice ?? "fast"]).notes,
        smartEndpointing: Boolean(plan?.smartEndpointingPlan) || plan?.smartEndpointingEnabled === true,
      };
    }
  }
  return { presets, choice, live };
}

/** מהטופס: שני קצבים, חמישה שדות לכל אחד. שדה ריק או לא מספר נדחה. */
export function presetsFromForm(form: FormData, styles: ResponseStyle[] = ["fast", "patient"]): Partial<TimingPresets> {
  const out: Partial<TimingPresets> = {};
  for (const style of styles) {
    const read = (key: string) => {
      const raw = String(form.get(`${style}.${key}`) ?? "").trim();
      const n = Number(raw);
      if (!raw || !Number.isFinite(n)) throw new ServiceError("validation", "כל השדות צריכים להיות מספרים.");
      return n;
    };
    out[style] = {
      waitSeconds: read("waitSeconds"),
      onPunctuationSeconds: read("onPunctuationSeconds"),
      onNoPunctuationSeconds: read("onNoPunctuationSeconds"),
      onNumberSeconds: read("onNumberSeconds"),
      endOfTurnSeconds: read("endOfTurnSeconds"),
    };
  }
  return out;
}
