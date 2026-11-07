// רשימות ה-assistants והמספרים מ-Vapi, לתפריטי הבחירה בטפסים

import { isNotNull } from "drizzle-orm";
import Link from "next/link";
import { getDb } from "@/db";
import { tenants } from "@/db/schema";
import { config } from "@/server/config";
import { cached, VAPI_LISTS_TTL_MS } from "@/server/memo";
import { isVapiConfigured, vapi } from "@/server/vapi-client";

export interface VapiOptions {
  configured: boolean;
  /** taken: למי ה-assistant כבר מחובר. assistant תפוס מוצג בתפריט אבל אי אפשר לבחור בו. */
  assistants: { id: string; name: string; taken?: string }[];
  phoneNumbers: { id: string; label: string }[];
}

/**
 * fresh: לטעון את הרשימות מ-Vapi עכשיו, בלי הזיכרון של כמה הדקות.
 * בשימוש כשמוסיפים assistant ב-Vapi ורוצים לראות אותו מיד (הקישור "רענון מ-Vapi").
 */
export async function vapiOptions({ fresh = false } = {}): Promise<VapiOptions> {
  if (!isVapiConfigured()) return { configured: false, assistants: [], phoneNumbers: [] };
  // הרשימות האלה משתנות רק כשמוסיפים assistant או מספר ב-Vapi, ולכן נשמרות לכמה דקות
  const [assistants, phoneNumbers, connected] = await Promise.all([
    cached("assistants:all", VAPI_LISTS_TTL_MS, () => vapi.listAssistants(), { fresh }).catch(() => []),
    cached("phone-numbers:all", VAPI_LISTS_TTL_MS, () => vapi.listPhoneNumbers(), { fresh }).catch(() => []),
    // מה מחובר כבר נקרא תמיד מה-DB, בלי זיכרון
    getDb()
      .select({ assistantId: tenants.vapiAssistantId, name: tenants.name })
      .from(tenants)
      .where(isNotNull(tenants.vapiAssistantId)),
  ]);
  const taken = new Map(connected.map((c) => [c.assistantId!, c.name]));
  taken.set(config.vapi.demoAssistantId(), "דמואים");

  return {
    configured: true,
    assistants: assistants.map((a) => ({ id: a.id, name: a.name ?? a.id, taken: taken.get(a.id) })),
    phoneNumbers: phoneNumbers.map((p) => ({
      id: p.id,
      label: [p.number, p.name].filter(Boolean).join(" · ") || p.id,
    })),
  };
}

/** קישור שטוען את אותו דף עם רשימות טריות מ-Vapi */
export function RefreshVapiLink({ path }: { path: string }) {
  return (
    <Link href={`${path}?fresh=1`} className="text-xs text-call hover:underline" prefetch={false}>
      לא רואה assistant שהוספת? רענון מ-Vapi
    </Link>
  );
}

export function AssistantSelect({
  options,
  name,
  required,
}: {
  options: VapiOptions;
  name: string;
  required?: boolean;
}) {
  // פנויים קודם, ואחריהם התפוסים (לידיעה בלבד)
  const sorted = [...options.assistants].sort((a, b) => Number(Boolean(a.taken)) - Number(Boolean(b.taken)));
  return (
    <select
      name={name}
      required={required}
      defaultValue=""
      className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-ink focus:border-call"
    >
      <option value="" disabled={required}>
        {required ? "לבחור assistant..." : "בלי"}
      </option>
      {sorted.map((a) => (
        <option key={a.id} value={a.id} disabled={Boolean(a.taken)}>
          {a.taken ? `${a.name} (מחובר ל${a.taken})` : a.name}
        </option>
      ))}
    </select>
  );
}

export function PhoneNumberSelect({ options, name }: { options: VapiOptions; name: string }) {
  return (
    <select
      name={name}
      defaultValue=""
      className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-ink focus:border-call"
    >
      <option value="">בלי מספר משלו (שיחות ניסיון מהמספר הכללי)</option>
      {options.phoneNumbers.map((p) => (
        <option key={p.id} value={p.id}>
          {p.label}
        </option>
      ))}
    </select>
  );
}
