// רשימות ה-assistants והמספרים מ-Vapi, לתפריטי הבחירה בטפסים

import { cached, VAPI_LISTS_TTL_MS } from "@/server/memo";
import { isVapiConfigured, vapi } from "@/server/vapi-client";

export interface VapiOptions {
  configured: boolean;
  assistants: { id: string; name: string }[];
  phoneNumbers: { id: string; label: string }[];
}

export async function vapiOptions(): Promise<VapiOptions> {
  if (!isVapiConfigured()) return { configured: false, assistants: [], phoneNumbers: [] };
  // הרשימות האלה משתנות רק כשמוסיפים assistant או מספר ב-Vapi, ולכן נשמרות לכמה דקות
  const [assistants, phoneNumbers] = await Promise.all([
    cached("assistants:all", VAPI_LISTS_TTL_MS, () => vapi.listAssistants()).catch(() => []),
    cached("phone-numbers:all", VAPI_LISTS_TTL_MS, () => vapi.listPhoneNumbers()).catch(() => []),
  ]);
  return {
    configured: true,
    assistants: assistants.map((a) => ({ id: a.id, name: a.name ?? a.id })),
    phoneNumbers: phoneNumbers.map((p) => ({ id: p.id, label: [p.number, p.name].filter(Boolean).join(" · ") || p.id })),
  };
}

export function AssistantSelect({ options, name, required }: { options: VapiOptions; name: string; required?: boolean }) {
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
      {options.assistants.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
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
