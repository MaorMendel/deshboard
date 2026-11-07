import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PROVIDERS, isVoiceProvider, providerLabel } from "@/lib/voice-providers";
import { isAdmin } from "@/server/admin-auth";
import { config } from "@/server/config";
import { isElevenLabsConfigured } from "@/server/elevenlabs-client";
import { listVoicesAdmin, type AdminVoice } from "@/server/voice-admin";
import {
  addVoiceAction,
  applyVoiceAction,
  generateSampleAction,
  importVoicesAction,
  updateVoiceAction,
  uploadSampleAction,
} from "../actions";
import { ActionForm, Field, inputCls } from "../forms";
import { AddVoiceForm } from "./add-voice-form";

export default function Page() {
  return (
    <Suspense fallback={<p className="text-ink-soft">טוען...</p>}>
      <Voices />
    </Suspense>
  );
}

function Pill({ tone, children }: { tone: "green" | "gray" | "amber"; children: React.ReactNode }) {
  const cls = {
    green: "bg-call-soft text-call-strong",
    gray: "bg-paper text-ink-soft border border-line",
    amber: "bg-pending-soft text-pending",
  }[tone];
  return <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{children}</span>;
}

async function Voices() {
  if (!(await isAdmin())) redirect("/admin/login");
  const all = await listVoicesAdmin();
  const sampleKeys = {
    "11labs": isElevenLabsConfigured(),
    cartesia: config.cartesiaApiKey().length > 0,
  };

  return (
    <main className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-semibold">קולות</h1>
          <p className="mt-1 text-sm text-ink-soft">
            הקולות שהלקוחות יכולים לבחור. הלקוח רואה רק שם, תיאור ודוגמת שמע. הספק, ה-ID והמודל נשמרים כאן, והשרת הוא
            שמתרגם את הבחירה שלו לקול ב-Vapi.
          </p>
        </div>
        <ActionForm action={importVoicesAction} submitLabel="ייבוא קולות מה-assistants ב-Vapi" subtle />
      </div>

      <details className="group rounded-xl border border-line bg-surface">
        <summary className="cursor-pointer list-none px-5 py-4 font-semibold marker:hidden">
          <span className="text-call-strong">+ הוספת קול</span>
          <span className="mr-2 text-sm font-normal text-ink-soft">ElevenLabs או Cartesia, לפי ה-Voice ID</span>
        </summary>
        <div className="border-t border-line p-5">
          <AddVoiceForm action={addVoiceAction} sampleKeys={sampleKeys} />
        </div>
      </details>

      {all.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong p-6 text-ink-soft">
          עוד אין קולות. אפשר לייבא מה-assistants ב-Vapi, או להוסיף קול לפי ה-ID שלו.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {all.map((v) => (
            <VoiceCard
              key={v.id}
              voice={v}
              canGenerate={v.canGenerate && isVoiceProvider(v.provider) && sampleKeys[v.provider]}
            />
          ))}
        </ul>
      )}
    </main>
  );
}

/** משתנה כשמשהו מהערכים השמורים משתנה */
function formVersion(v: AdminVoice): string {
  return [v.name, v.gender, v.description, v.tier, v.sortOrder, v.isActive, v.model, v.speed, v.stability].join("|");
}

function VoiceCard({ voice: v, canGenerate }: { voice: AdminVoice; canGenerate: boolean }) {
  const placeholder = v.providerVoiceId === "REPLACE_ME";
  const known = isVoiceProvider(v.provider) ? PROVIDERS[v.provider] : null;

  return (
    <li className="rounded-xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-lg font-semibold">{v.name}</span>
        {v.isActive ? <Pill tone="green">מוצג ללקוחות</Pill> : <Pill tone="gray">כבוי</Pill>}
        {v.tier === "premium" && <Pill tone="gray">פרימיום</Pill>}
        {v.usedBy > 0 && <Pill tone="gray">נבחר אצל {v.usedBy}</Pill>}
        {!v.hasSample && !v.sampleUrl && !placeholder && <Pill tone="amber">אין דוגמת שמע</Pill>}
        {placeholder && <Pill tone="amber">קול לדוגמה, לא אמיתי</Pill>}
      </div>
      <p className="mt-1 text-sm text-ink-soft">
        {v.gender === "female" ? "אישה" : "גבר"}
        {v.description && `, ${v.description}`}
      </p>
      <p className="mt-1 font-mono text-xs text-ink-soft" dir="ltr">
        {providerLabel(v.provider)} · {v.model ?? "default model"}
        {v.speed != null && ` · speed ${v.speed}`}
        {v.stability != null && ` · stability ${v.stability}`} · {v.providerVoiceId}
      </p>

      <div className="mt-4 flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 basis-64">
          {v.sampleUrl ? (
            <audio controls preload="none" src={v.sampleUrl} className="h-10 w-full max-w-sm" />
          ) : (
            <p className="text-sm text-ink-soft">אין דוגמה. בלעדיה הלקוח לא יכול לשמוע את הקול לפני שהוא בוחר.</p>
          )}
        </div>
        {!placeholder && (
          <div className="flex flex-wrap items-start gap-3">
            {canGenerate && (
              <ActionForm
                action={generateSampleAction.bind(null, v.id)}
                submitLabel={v.hasSample ? "ליצור דוגמה מחדש" : "ליצור דוגמה"}
                subtle
                confirmText={v.hasSample ? "להחליף את הדוגמה הקיימת בדוגמה חדשה מהספק?" : undefined}
              />
            )}
            <ActionForm action={uploadSampleAction.bind(null, v.id)} submitLabel="להעלות MP3" subtle>
              <input
                type="file"
                name="file"
                accept="audio/mpeg,.mp3"
                required
                className="max-w-56 text-sm file:ml-2 file:rounded-md file:border file:border-line-strong file:bg-surface file:px-2 file:py-1"
              />
            </ActionForm>
          </div>
        )}
      </div>

      <details className="mt-4 border-t border-line pt-3">
        <summary className="cursor-pointer text-sm font-medium text-call-strong">עריכה</summary>
        <div className="mt-3">
          <ActionForm action={updateVoiceAction.bind(null, v.id)} submitLabel="לשמור">
            {/* key: אחרי שמירה השדות נבנים מחדש מהערכים השמורים. בלעדיו תפריט נשאר על הערך הישן,
                ושמירה נוספת הייתה מחזירה אותו. ההודעה של הטופס נשמרת, כי רק השדות מתחלפים. */}
            <div key={formVersion(v)} className="grid gap-3 sm:grid-cols-2">
              <Field label="שם">
                <input name="name" required maxLength={40} defaultValue={v.name} className={inputCls} />
              </Field>
              <Field label="מגדר">
                <select name="gender" defaultValue={v.gender} className={inputCls}>
                  <option value="female">אישה</option>
                  <option value="male">גבר</option>
                </select>
              </Field>
              <Field label="תיאור">
                <input name="description" maxLength={120} defaultValue={v.description} className={inputCls} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="רמה">
                  <select name="tier" defaultValue={v.tier} className={inputCls}>
                    <option value="standard">רגיל</option>
                    <option value="premium">פרימיום</option>
                  </select>
                </Field>
                <Field label="סדר" hint="נמוך = למעלה">
                  <input name="sortOrder" type="number" defaultValue={v.sortOrder} className={inputCls} dir="ltr" />
                </Field>
              </div>
              {known && (
                <>
                  <Field label="מודל" hint={known.modelHint}>
                    <select name="model" defaultValue={v.model ?? ""} className={inputCls} dir="ltr">
                      <option value="">(ברירת המחדל של Vapi)</option>
                      {v.model && !known.models.includes(v.model) && <option value={v.model}>{v.model}</option>}
                      {known.models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="מהירות" hint={`${known.speed[0]}-${known.speed[1]}`}>
                      <input
                        name="speed"
                        type="number"
                        step="0.05"
                        min={known.speed[0]}
                        max={known.speed[1]}
                        defaultValue={v.speed ?? ""}
                        className={inputCls}
                        dir="ltr"
                      />
                    </Field>
                    {known.stability && (
                      <Field label="Stability" hint="0-1">
                        <input
                          name="stability"
                          type="number"
                          step="0.05"
                          min={0}
                          max={1}
                          defaultValue={v.stability ?? ""}
                          className={inputCls}
                          dir="ltr"
                        />
                      </Field>
                    )}
                  </div>
                </>
              )}
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input
                  type="checkbox"
                  name="isActive"
                  defaultChecked={v.isActive}
                  disabled={placeholder}
                  className="size-4 accent-[var(--color-call)]"
                />
                להציג ללקוחות
              </label>
            </div>
          </ActionForm>

          {known && !placeholder && (
            <div className="mt-5 rounded-lg bg-paper p-4">
              <p className="mb-3 text-sm text-ink-soft">
                שינוי מודל או מהירות חל מיד על כל בחירה חדשה של הקול ועל שיחות ניסיון. בוטים שכבר עובדים עם הקול ממשיכים
                עם ההגדרה הקודמת עד שמחילים עליהם:
              </p>
              <ActionForm
                action={applyVoiceAction.bind(null, v.id)}
                submitLabel={`להחיל את ההגדרות של ${v.name} על כל ה-assistants שמשתמשים בו`}
                subtle
                confirmText={`לעדכן עכשיו ב-Vapi כל assistant של לקוח שמדבר בקול ${v.name}? השינוי חל מהשיחה הבאה שלהם.`}
              />
            </div>
          )}
        </div>
      </details>
    </li>
  );
}
