// מי נכנס: מפתח מה-URL -> הלקוח. זה המקום היחיד שקובע לאיזה לקוח שייכת בקשה.
// אף route לא מקבל tenantId או assistantId מהדפדפן.

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { hashAccessKey } from "@/db/access-keys";
import { accessLinks, tenants, type Tenant } from "@/db/schema";
import { ServiceError } from "./errors";

export interface Access {
  tenant: Tenant;
  linkId: string;
}

export type AccessResult =
  | ({ state: "ok" } & Access)
  | { state: "invalid" }
  | { state: "suspended"; tenantName: string }
  | { state: "demo_expired"; tenantName: string };

/** כמה זמן בין עדכונים של last_used_at, כדי לא לכתוב ל-DB בכל בקשה */
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

export async function findAccess(key: string): Promise<AccessResult> {
  if (!key || key.length < 20 || key.length > 200) return { state: "invalid" };
  const db = getDb();
  const [row] = await db
    .select({ tenant: tenants, linkId: accessLinks.id, revokedAt: accessLinks.revokedAt, lastUsedAt: accessLinks.lastUsedAt })
    .from(accessLinks)
    .innerJoin(tenants, eq(accessLinks.tenantId, tenants.id))
    .where(eq(accessLinks.tokenHash, hashAccessKey(key)));

  if (!row || row.revokedAt) return { state: "invalid" };
  if (row.tenant.status === "suspended") return { state: "suspended", tenantName: row.tenant.name };
  if (row.tenant.type === "demo" && row.tenant.demoExpiresAt && row.tenant.demoExpiresAt.getTime() < Date.now()) {
    return { state: "demo_expired", tenantName: row.tenant.name };
  }

  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
    await db.update(accessLinks).set({ lastUsedAt: new Date() }).where(eq(accessLinks.id, row.linkId));
  }
  return { state: "ok", tenant: row.tenant, linkId: row.linkId };
}

/** כמו findAccess, אבל זורק שגיאה מתאימה כשאין גישה. ל-API routes. */
export async function requireAccess(key: string): Promise<Access> {
  const result = await findAccess(key);
  switch (result.state) {
    case "ok":
      return { tenant: result.tenant, linkId: result.linkId };
    case "suspended":
      throw new ServiceError("suspended", "החשבון מושהה. כדאי לפנות אלינו.");
    case "demo_expired":
      throw new ServiceError("demo_ended", "תקופת הדמו הסתיימה. כדאי לפנות אלינו כדי להמשיך.");
    default:
      throw new ServiceError("unauthorized", "הקישור לא תקין או שבוטל.");
  }
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export function requestMeta(request: Request): RequestMeta {
  const forwarded = request.headers.get("x-forwarded-for");
  return {
    ip: forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip"),
    userAgent: request.headers.get("user-agent"),
  };
}

export function maskPhone(e164: string): string {
  const local = e164.replace(/^\+972/, "0");
  return `${local.slice(0, 3)}-•••-${local.slice(-4)}`;
}
