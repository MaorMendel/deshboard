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
import { ServiceError } from "@/server/errors";

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
