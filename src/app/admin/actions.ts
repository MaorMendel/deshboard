"use server";

// הפעולות של פאנל הניהול. כל אחת בודקת קודם שהמשתמש מחובר כאדמין,
// ואז קוראת לאותן פונקציות שמשמשות את פקודות ה-CLI.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { adminConfigured, clearAdminSession, isAdmin, passwordOk, setAdminSession } from "@/server/admin-auth";
import {
  convertDemo,
  createCustomer,
  createDemo,
  issueLink,
  revokeLinks,
  setTenantStatus,
  updateAssistantPrompt,
  updatePlan,
} from "@/server/admin-service";
import { config } from "@/server/config";
import { isElevenLabsConfigured } from "@/server/elevenlabs-client";
import { ServiceError } from "@/server/errors";
import { addVoice, applyVoiceToAssistants, generateSample, updateVoice, uploadSample } from "@/server/voice-admin";
import { importVoicesFromVapi } from "@/server/voice-catalog";

export type ActionResult = { error?: string; ok?: string; url?: string } | null;

function failure(err: unknown): ActionResult {
  if (err instanceof ServiceError) return { error: err.message };
  console.error(err);
  return { error: "משהו השתבש. אפשר לנסות שוב בעוד רגע." };
}

async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) redirect("/admin/login");
}

const text = (form: FormData, name: string): string => String(form.get(name) ?? "").trim();
const optional = (form: FormData, name: string): string | undefined => text(form, name) || undefined;

/** תאריך מ-input type=date (למשל "2026-11-01"), או null אם ריק */
function dateField(form: FormData, name: string): Date | null {
  const value = text(form, name);
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function intField(form: FormData, name: string): number | null {
  const value = text(form, name);
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// ---------- כניסה ויציאה ----------

export async function loginAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  if (!adminConfigured()) {
    return { error: "פאנל הניהול כבוי: צריך להגדיר ADMIN_PASSWORD בשרת (לפחות 8 תווים) ולהפעיל מחדש." };
  }
  if (!passwordOk(text(form, "password"))) {
    return { error: "הסיסמה לא נכונה." };
  }
  await setAdminSession();
  redirect("/admin");
}

export async function logoutAction(): Promise<void> {
  await clearAdminSession();
  redirect("/admin/login");
}

// ---------- יצירה ----------

export async function createCustomerAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  await requireAdmin();
  try {
    const minutes = intField(form, "planMinutes");
    const { tenant, url } = await createCustomer({
      name: text(form, "name"),
      externalCustomerId: text(form, "externalId"),
      vapiAssistantId: text(form, "assistantId"),
      vapiPhoneNumberId: optional(form, "phoneNumberId"),
      botPhoneDisplay: optional(form, "botPhone"),
      verifiedPhone: optional(form, "testPhone"),
      planStartedAt: dateField(form, "planStartedAt") ?? undefined,
      planMinutes: minutes ?? undefined,
    });
    revalidatePath("/admin");
    return { ok: `נוצר הלקוח ${tenant.name}. זה הקישור שלו - הוא מוצג רק עכשיו:`, url };
  } catch (err) {
    return failure(err);
  }
}

export async function createDemoAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  await requireAdmin();
  try {
    const { tenant, url } = await createDemo({
      name: text(form, "name"),
      verifiedPhone: optional(form, "testPhone"),
      minutes: intField(form, "minutes") ?? undefined,
      days: intField(form, "days") ?? undefined,
    });
    revalidatePath("/admin");
    return { ok: `נוצר הדמו ${tenant.name}. זה הקישור שלו - הוא מוצג רק עכשיו:`, url };
  } catch (err) {
    return failure(err);
  }
}

// ---------- פעולות על לקוח ----------

function refresh(tenantId: string) {
  revalidatePath("/admin");
  revalidatePath(`/admin/t/${tenantId}`);
}

export async function updatePlanAction(tenantId: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  await requireAdmin();
  try {
    await updatePlan(tenantId, { startedAt: dateField(form, "planStartedAt"), minutes: intField(form, "planMinutes") });
    refresh(tenantId);
    return { ok: "החבילה עודכנה." };
  } catch (err) {
    return failure(err);
  }
}

export async function issueLinkAction(tenantId: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  await requireAdmin();
  try {
    const keepOld = form.get("keepOld") === "on";
    const { url } = await issueLink(tenantId, { label: optional(form, "label"), revokeOthers: !keepOld });
    refresh(tenantId);
    return {
      ok: keepOld ? "נוצר קישור נוסף - הוא מוצג רק עכשיו:" : "נוצר קישור חדש והקודמים בוטלו - הוא מוצג רק עכשיו:",
      url,
    };
  } catch (err) {
    return failure(err);
  }
}

export async function revokeLinksAction(tenantId: string): Promise<void> {
  await requireAdmin();
  await revokeLinks(tenantId).catch(() => null);
  refresh(tenantId);
}

export async function setStatusAction(tenantId: string, status: "active" | "suspended"): Promise<void> {
  await requireAdmin();
  await setTenantStatus(tenantId, status).catch(() => null);
  refresh(tenantId);
}

export async function convertDemoAction(tenantId: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  await requireAdmin();
  try {
    const tenant = await convertDemo(tenantId, {
      externalCustomerId: text(form, "externalId"),
      vapiAssistantId: text(form, "assistantId"),
      vapiPhoneNumberId: optional(form, "phoneNumberId"),
      botPhoneDisplay: optional(form, "botPhone"),
    });
    const minutes = intField(form, "planMinutes");
    const startedAt = dateField(form, "planStartedAt");
    if (minutes && startedAt) await updatePlan(tenant.id, { startedAt, minutes });
    refresh(tenantId);
    return { ok: `${tenant.name} הוא עכשיו לקוח משלם. הקישור הקיים שלו ממשיך לעבוד.` };
  } catch (err) {
    return failure(err);
  }
}

export async function savePromptAction(tenantId: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  await requireAdmin();
  try {
    await updateAssistantPrompt(tenantId, String(form.get("prompt") ?? ""));
    refresh(tenantId);
    return { ok: "הפרומפט עודכן ב-Vapi. הוא פעיל מהשיחה הבאה." };
  } catch (err) {
    return failure(err);
  }
}

// ---------- קולות ----------

/** מספר משדה כיוונון: undefined כשהשדה לא בטופס, null כשהוא ריק (= להסיר את ההגדרה) */
function tuningNumber(form: FormData, name: string): number | null | undefined {
  if (!form.has(name)) return undefined;
  const value = text(form, name);
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ServiceError("validation", `הערך בשדה ${name} לא מספר.`);
  return n;
}

function voiceDetails(form: FormData) {
  return {
    name: text(form, "name"),
    gender: text(form, "gender"),
    description: text(form, "description"),
    tier: text(form, "tier") || "standard",
    sortOrder: intField(form, "sortOrder") ?? 0,
    isActive: form.get("isActive") === "on",
    model: form.has("model") ? text(form, "model") : undefined,
    speed: tuningNumber(form, "speed"),
    stability: tuningNumber(form, "stability"),
  };
}

function canGenerateFor(provider: string): boolean {
  if (provider === "11labs") return isElevenLabsConfigured();
  if (provider === "cartesia") return config.cartesiaApiKey().length > 0;
  return false;
}

const KEY_NAME: Record<string, string> = { "11labs": "ELEVENLABS_API_KEY", cartesia: "CARTESIA_API_KEY" };

export async function importVoicesAction(): Promise<ActionResult> {
  await requireAdmin();
  try {
    const r = await importVoicesFromVapi();
    const added = r.voices.filter((v) => v.isNew).length;
    revalidatePath("/admin/voices");
    return {
      ok: added
        ? `נסרקו ${r.assistantsScanned} assistants ונוספו ${added} קולות חדשים. הם כבויים עד שנותנים להם שם ומפעילים.`
        : `נסרקו ${r.assistantsScanned} assistants. אין קולות חדשים.`,
    };
  } catch (err) {
    return failure(err);
  }
}

export async function addVoiceAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  await requireAdmin();
  try {
    const provider = text(form, "provider");
    const voice = await addVoice({ ...voiceDetails(form), provider, providerVoiceId: text(form, "providerVoiceId") });
    revalidatePath("/admin/voices");
    if (!canGenerateFor(provider)) {
      return {
        ok: `הקול ${voice.name} נוסף. אין ${KEY_NAME[provider] ?? "מפתח"} בשרת, אז אין דוגמה אוטומטית. אפשר להעלות MP3 ברשימה.`,
      };
    }
    try {
      await generateSample(voice.id);
      return { ok: `הקול ${voice.name} נוסף ונוצרה לו דוגמת שמע. אפשר להאזין לה ברשימה.` };
    } catch (err) {
      const reason = err instanceof ServiceError ? err.message : "שגיאה לא צפויה";
      return { ok: `הקול ${voice.name} נוסף, אבל ${reason} כדאי לבדוק את ה-Voice ID ואת המודל.` };
    }
  } catch (err) {
    return failure(err);
  }
}

export async function updateVoiceAction(voiceId: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  await requireAdmin();
  try {
    const { voice, tuningChanged } = await updateVoice(voiceId, voiceDetails(form));
    revalidatePath("/admin/voices");
    return {
      ok: tuningChanged
        ? `נשמר. ההגדרות החדשות של ${voice.name} חלות על כל בחירה חדשה של הקול ועל שיחות ניסיון. כדאי ליצור דוגמה חדשה, ואם יש לקוחות שכבר משתמשים בקול, להחיל עליהם.`
        : "נשמר.",
    };
  } catch (err) {
    return failure(err);
  }
}

export async function generateSampleAction(voiceId: string): Promise<ActionResult> {
  await requireAdmin();
  try {
    await generateSample(voiceId);
    revalidatePath("/admin/voices");
    return { ok: "נוצרה דוגמה חדשה." };
  } catch (err) {
    return failure(err);
  }
}

export async function uploadSampleAction(voiceId: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  await requireAdmin();
  try {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "צריך לבחור קובץ MP3." };
    await uploadSample(voiceId, Buffer.from(await file.arrayBuffer()));
    revalidatePath("/admin/voices");
    return { ok: "הדוגמה הועלתה. הלקוחות ישמעו אותה מעכשיו." };
  } catch (err) {
    return failure(err);
  }
}

export async function applyVoiceAction(voiceId: string): Promise<ActionResult> {
  await requireAdmin();
  try {
    const { updated, failed } = await applyVoiceToAssistants(voiceId);
    if (failed.length) {
      return {
        error: `עודכנו ${updated.length}. נכשלו: ${failed.join(", ")}. אפשר לנסות שוב, זה בטוח.`,
      };
    }
    return {
      ok: updated.length
        ? `עודכנו ${updated.length} assistants: ${updated.join(", ")}.`
        : "אף assistant לא משתמש כרגע בקול הזה ב-Vapi. אין מה לעדכן.",
    };
  } catch (err) {
    return failure(err);
  }
}
