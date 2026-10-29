import { redirect } from "next/navigation";
import { Suspense } from "react";
import { isAdmin } from "@/server/admin-auth";
import { PROMPT_MAX } from "@/lib/validation";
import { getAssistantPrompt, tenantDetail, type TenantDetail } from "@/server/admin-service";
import { ServiceError } from "@/server/errors";
import { isVapiConfigured } from "@/server/vapi-client";
import {
  convertDemoAction,
  issueLinkAction,
  revokeLinksAction,
  savePromptAction,
  setStatusAction,
  updatePlanAction,
} from "../../actions";
import { fmtDate, fmtDateTime, fmtSeconds, dateInputValue } from "../../format";
import { ActionForm, ConfirmButton, CopyLink, Field, inputCls } from "../../forms";
import { AssistantSelect, PhoneNumberSelect, vapiOptions } from "../../vapi-options";

export default function Page({ params }: PageProps<"/admin/t/[id]">) {
  return (
    <Suspense fallback={<p className="text-ink-soft">טוען...</p>}>
      <Detail params={params} />
    </Suspense>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <h2 className="mb-4 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Detail_row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line py-2 text-sm last:border-0">
      <span className="text-ink-soft">{label}</span>
      <span className="text-left">{value ?? "—"}</span>
    </div>
  );
}

const CALL_TYPE: Record<string, string> = { test: "ניסיון", inbound: "נכנסת", outbound: "יוצאת" };
const CALL_STATUS: Record<string, string> = { ended: "הסתיימה", in_progress: "בשיחה", queued: "ממתינה", failed: "נכשלה" };

async function Detail({ params }: { params: PageProps<"/admin/t/[id]">["params"] }) {
  if (!(await isAdmin())) redirect("/admin/login");
  const { id } = await params;

  let detail: TenantDetail;
  try {
    detail = await tenantDetail(id);
  } catch (err) {
    if (err instanceof ServiceError) return <p className="rounded-xl bg-danger-soft p-4 text-danger">{err.message}</p>;
    throw err;
  }
  const { tenant, usage, links, recentCalls } = detail;
  const isDemo = tenant.type === "demo";
  const suspended = tenant.status === "suspended";

  return (
    <main className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{tenant.name}</h1>
          <p className="text-sm text-ink-soft">
            {isDemo ? "דמו" : `לקוח #${tenant.externalCustomerId}`}
            {suspended && <span className="mr-2 rounded-full bg-danger-soft px-2 py-0.5 text-xs text-danger">מושהה</span>}
          </p>
        </div>
        <ConfirmButton
          action={setStatusAction.bind(null, tenant.id, suspended ? "active" : "suspended")}
          label={suspended ? "להחזיר לפעילות" : "להשעות"}
          confirmText={
            suspended
              ? `להחזיר את ${tenant.name} לפעילות?`
              : `להשעות את ${tenant.name}? הקישורים שלו יפסיקו לעבוד עד שיוחזר לפעילות. הבוט ב-Vapi ממשיך לענות כרגיל.`
          }
          danger={!suspended}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="פרטים">
          <Detail_row label="נוצר" value={fmtDate(tenant.createdAt)} />
          <Detail_row label="טלפון לשיחות ניסיון" value={tenant.verifiedPhone && <bdi dir="ltr">{tenant.verifiedPhone}</bdi>} />
          <Detail_row label="המספר של הבוט" value={tenant.botPhoneDisplay && <bdi dir="ltr">{tenant.botPhoneDisplay}</bdi>} />
          <Detail_row
            label="assistant ב-Vapi"
            value={tenant.vapiAssistantId && <code dir="ltr" className="text-xs">{tenant.vapiAssistantId}</code>}
          />
          {detail.settings && (
            <>
              <Detail_row label="מי מדבר ראשון" value={detail.settings.firstSpeaker === "bot" ? "הבוט" : "המתקשר"} />
              <Detail_row label="קול" value={detail.settings.voiceId} />
            </>
          )}
        </Section>

        {isDemo ? (
          <Section title="הדמו">
            <Detail_row
              label="שיחות ניסיון"
              value={`${fmtSeconds(detail.demoUsedSeconds ?? 0)} מתוך ${fmtSeconds(tenant.demoSecondsLimit ?? 0)}`}
            />
            <Detail_row label="בתוקף עד" value={fmtDate(tenant.demoExpiresAt)} />
          </Section>
        ) : (
          <Section title="החבילה">
            {usage ? (
              <p className="mb-4 rounded-lg bg-paper px-3 py-2 text-sm">
                במחזור הנוכחי ({fmtDate(usage.cycleStart)} עד {fmtDate(usage.cycleEnd)}) נוצלו{" "}
                <strong className={usage.usedMinutes >= usage.limitMinutes ? "text-danger" : undefined}>
                  {usage.usedMinutes} מתוך {usage.limitMinutes} דקות
                </strong>
                . המונה מתאפס ב-{fmtDate(usage.cycleEnd)}.
              </p>
            ) : (
              <p className="mb-4 text-sm text-ink-soft">עוד לא הוגדרה חבילה, והלקוח לא רואה מונה דקות.</p>
            )}
            <ActionForm action={updatePlanAction.bind(null, tenant.id)} submitLabel="לעדכן את החבילה" subtle>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="תחילת החבילה" hint="המונה מתאפס כל חודש ביום הזה">
                  <input
                    name="planStartedAt"
                    type="date"
                    defaultValue={dateInputValue(tenant.planStartedAt)}
                    className={inputCls}
                    dir="ltr"
                  />
                </Field>
                <Field label="דקות בחודש">
                  <input
                    name="planMinutes"
                    type="number"
                    min={1}
                    defaultValue={tenant.planMinutes ?? ""}
                    className={inputCls}
                    dir="ltr"
                  />
                </Field>
              </div>
            </ActionForm>
          </Section>
        )}
      </div>

      <Section title="קישורים">
        {links.length > 0 && (
          <div className="mb-4 overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead>
                <tr className="border-b border-line text-right text-ink-soft">
                  <th className="py-2 font-medium">תווית</th>
                  <th className="py-2 font-medium">הקישור</th>
                  <th className="py-2 font-medium">נוצר</th>
                  <th className="py-2 font-medium">שימוש אחרון</th>
                  <th className="py-2 font-medium">מצב</th>
                </tr>
              </thead>
              <tbody>
                {links.map((link) => (
                  <tr key={link.id} className="border-b border-line last:border-0">
                    <td className="py-2">{link.label}</td>
                    <td className="py-2">
                      {link.revokedAt ? (
                        <span className="text-ink-soft">—</span>
                      ) : link.url ? (
                        <CopyLink url={link.url} />
                      ) : (
                        <span className="text-ink-soft">לא זמין לצפייה</span>
                      )}
                    </td>
                    <td className="py-2 text-ink-soft">{fmtDate(link.createdAt)}</td>
                    <td className="py-2 text-ink-soft">{fmtDateTime(link.lastUsedAt)}</td>
                    <td className="py-2">
                      {link.revokedAt ? <span className="text-danger">בוטל</span> : <span className="text-call-strong">פעיל</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex-1">
            <ActionForm action={issueLinkAction.bind(null, tenant.id)} submitLabel="להנפיק קישור" subtle>
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-48 flex-1">
                  <Field label="תווית" hint="למי הקישור, למשל 'המזכירה'">
                    <input name="label" className={inputCls} />
                  </Field>
                </div>
                <label className="flex items-center gap-2 pb-5 text-sm">
                  <input type="checkbox" name="keepOld" className="size-4 accent-call" />
                  להשאיר את הקישורים הקודמים
                </label>
              </div>
            </ActionForm>
          </div>
          <ConfirmButton
            action={revokeLinksAction.bind(null, tenant.id)}
            label="לבטל את כל הקישורים"
            confirmText={`לבטל את כל הקישורים של ${tenant.name}? הם יפסיקו לעבוד מיד, ואי אפשר לשחזר אותם.`}
            danger
          />
        </div>
      </Section>

      {isDemo && (
        <Section title="להפוך ללקוח משלם">
          <ConvertSection tenantId={tenant.id} />
        </Section>
      )}

      {!isDemo && tenant.vapiAssistantId && isVapiConfigured() && (
        <Section title="הנחיות הבוט (פרומפט)">
          <Suspense fallback={<p className="text-ink-soft">טוען את הפרומפט מ-Vapi...</p>}>
            <PromptSection tenantId={tenant.id} />
          </Suspense>
        </Section>
      )}

      <Section title="שיחות אחרונות">
        {recentCalls.length === 0 ? (
          <p className="text-sm text-ink-soft">עוד אין שיחות.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-line text-right text-ink-soft">
                  <th className="py-2 font-medium">מתי</th>
                  <th className="py-2 font-medium">סוג</th>
                  <th className="py-2 font-medium">מצב</th>
                  <th className="py-2 font-medium">משך</th>
                  <th className="py-2 font-medium">מספר</th>
                </tr>
              </thead>
              <tbody>
                {recentCalls.map((call) => (
                  <tr key={call.id} className="border-b border-line last:border-0">
                    <td className="py-2">{fmtDateTime(call.startedAt)}</td>
                    <td className="py-2">{CALL_TYPE[call.type] ?? call.type}</td>
                    <td className="py-2">{CALL_STATUS[call.status] ?? call.status}</td>
                    <td className="py-2">{fmtSeconds(call.durationSeconds)}</td>
                    <td className="py-2">{call.customerNumber ? <bdi dir="ltr">{call.customerNumber}</bdi> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </main>
  );
}

async function ConvertSection({ tenantId }: { tenantId: string }) {
  const options = await vapiOptions();
  if (!options.configured) {
    return <p className="text-sm text-danger">VAPI_PRIVATE_KEY לא מוגדר בשרת, אי אפשר להמיר דמו.</p>;
  }
  return (
    <>
      <p className="mb-4 text-sm text-ink-soft">
        הקול, הפתיח והסגירה שהוגדרו בדמו נשלחים ל-assistant שנבחר, והקישור הקיים ממשיך לעבוד.
      </p>
      <ActionForm action={convertDemoAction.bind(null, tenantId)} submitLabel="להפוך ללקוח">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="מזהה במערכת הראשית">
            <input name="externalId" required className={inputCls} dir="ltr" />
          </Field>
          <Field label="ה-assistant של הלקוח">
            <AssistantSelect options={options} name="assistantId" required />
          </Field>
          <Field label="המספר שהבוט עונה בו">
            <PhoneNumberSelect options={options} name="phoneNumberId" />
          </Field>
          <Field label="המספר לתצוגה">
            <input name="botPhone" className={inputCls} dir="ltr" />
          </Field>
          <Field label="תחילת החבילה">
            <input name="planStartedAt" type="date" className={inputCls} dir="ltr" />
          </Field>
          <Field label="דקות בחודש">
            <input name="planMinutes" type="number" min={1} className={inputCls} dir="ltr" />
          </Field>
        </div>
      </ActionForm>
    </>
  );
}

async function PromptSection({ tenantId }: { tenantId: string }) {
  let prompt: string;
  let model: string | null;
  try {
    ({ prompt, model } = await getAssistantPrompt(tenantId));
  } catch (err) {
    const message = err instanceof ServiceError ? err.message : "לא הצלחנו לקרוא את הפרומפט מ-Vapi.";
    return <p className="text-sm text-danger">{message}</p>;
  }
  return (
    <ActionForm action={savePromptAction.bind(null, tenantId)} submitLabel="לעדכן את הפרומפט ב-Vapi">
      <Field
        label={model ? `הודעת ה-system (מודל: ${model})` : "הודעת ה-system"}
        hint="נשלח ל-Vapi כמו שהוא. שאר הגדרות ה-model (מודל, טמפרטורה, כלים) לא משתנות."
      >
        <textarea
          name="prompt"
          defaultValue={prompt}
          required
          maxLength={PROMPT_MAX}
          rows={14}
          className={`${inputCls} font-mono text-sm leading-relaxed`}
          dir="auto"
        />
      </Field>
    </ActionForm>
  );
}
