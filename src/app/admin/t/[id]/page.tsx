import Link from "next/link";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { Suspense } from "react";
import { isAdmin } from "@/server/admin-auth";
import { PROMPT_MAX } from "@/lib/validation";
import { describeChanges } from "@/lib/version-diff";
import { findTenant, getAssistantPrompt, tenantDetail, type TenantDetail } from "@/server/admin-service";
import { listVersions, type VersionEntry, type VersionHistory } from "@/server/versions";
import { ServiceError } from "@/server/errors";
import { isVapiConfigured } from "@/server/vapi-client";
import {
  convertDemoAction,
  issueLinkAction,
  restoreVersionAction,
  revokeLinksAction,
  savePromptAction,
  setStatusAction,
  updatePlanAction,
} from "../../actions";
import { fmtAgo, fmtDate, fmtDateTime, fmtSeconds, fmtUsd, fmtUsdRate, dateInputValue } from "../../format";
import { ActionForm, ConfirmButton, CopyLink, Field, inputCls } from "../../forms";
import { AssistantSelect, PhoneNumberSelect, RefreshVapiLink, vapiOptions } from "../../vapi-options";

export default function Page({ params, searchParams }: PageProps<"/admin/t/[id]">) {
  return (
    <Suspense fallback={<p className="text-ink-soft">טוען...</p>}>
      <Detail params={params} searchParams={searchParams} />
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

async function Detail({
  params,
  searchParams,
}: {
  params: PageProps<"/admin/t/[id]">["params"];
  searchParams: PageProps<"/admin/t/[id]">["searchParams"];
}) {
  if (!(await isAdmin())) redirect("/admin/login");
  const { id } = await params;
  const { fresh } = await searchParams;

  let detail: TenantDetail;
  try {
    detail = await tenantDetail(id, {
      // העמוד לא מחכה ל-Vapi יותר משנייה וחצי. אם הסנכרון איטי, הוא ממשיך ברקע ומופיע בטעינה הבאה.
      // ברענון ידני מחכים עד שזה נגמר, כי זה מה שביקשו.
      syncWaitMs: fresh === "1" ? 20_000 : 1_500,
      forceSync: fresh === "1",
      onBackground: (pending) => after(() => pending),
    });
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
          <SyncStatus detail={detail} />
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

      <CostSection detail={detail} />

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
          {/* רשימת ה-assistants באה מ-Vapi. בנפרד, כדי ששאר העמוד לא יחכה לה */}
          <Suspense fallback={<p className="text-sm text-ink-soft">טוען את ה-assistants מ-Vapi...</p>}>
            <ConvertSection tenantId={tenant.id} fresh={fresh === "1"} />
          </Suspense>
        </Section>
      )}

      {!isDemo && tenant.vapiAssistantId && isVapiConfigured() && (
        <Section title="הנחיות הבוט (פרומפט)">
          <Suspense fallback={<p className="text-ink-soft">טוען את הפרומפט מ-Vapi...</p>}>
            <PromptSection tenantId={tenant.id} />
          </Suspense>
        </Section>
      )}

      <Section title="היסטוריית גרסאות">
        <p className="mb-4 text-sm text-ink-soft">
          כל &quot;עדכן את הבוט&quot; של הלקוח, וכל עריכת הנחיות מכאן, נשמרים כגרסה. חזרה לגרסה קודמת יוצרת גרסה חדשה,
          כך שאפשר לבטל גם אותה. שינויים שנעשו ישירות ב-Vapi לא מופיעים כאן.
        </p>
        {/* נטען בנפרד, כדי ששאר העמוד לא יחכה לו */}
        <Suspense fallback={<p className="text-sm text-ink-soft">טוען את הגרסאות...</p>}>
          <HistorySection tenantId={tenant.id} />
        </Suspense>
      </Section>

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
                  <th className="py-2 font-medium">עלות</th>
                  <th className="py-2 font-medium">מספר</th>
                </tr>
              </thead>
              <tbody>
                {recentCalls.map((call) => (
                  <tr key={call.id} className="border-b border-line last:border-0">
                    <td className="py-2">{fmtDateTime(call.startedAt ?? call.createdAt)}</td>
                    <td className="py-2">{CALL_TYPE[call.type] ?? call.type}</td>
                    <td className="py-2">{CALL_STATUS[call.status] ?? call.status}</td>
                    <td className="py-2">{fmtSeconds(call.durationSeconds)}</td>
                    <td className="py-2 tabular-nums">
                      <bdi dir="ltr">{call.costUsd != null ? fmtUsd(call.costUsd) : "—"}</bdi>
                    </td>
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

function versionAuthor(v: VersionEntry): string {
  if (v.restoredFrom) return `חזרה לגרסה ${v.restoredFrom}`;
  if (v.by === "link") return v.linkLabel ? `הלקוח (${v.linkLabel})` : "הלקוח";
  if (v.by === "admin") return "מהפאנל";
  return "המערכת";
}

async function HistorySection({ tenantId }: { tenantId: string }) {
  let tenant: Awaited<ReturnType<typeof findTenant>>;
  let history: VersionHistory;
  try {
    tenant = await findTenant(tenantId);
    history = await listVersions(tenant);
  } catch (err) {
    console.error("history:", err);
    return <p className="text-sm text-danger">לא הצלחתי לטעון את הגרסאות.</p>;
  }
  if (history.versions.length === 0) return <p className="text-sm text-ink-soft">עוד אין גרסאות.</p>;

  const voiceName = (id: string) => history.voiceNames[id] ?? id;
  const isCustomer = tenant.type === "customer";

  return (
    <>
      <ol className="divide-y divide-line">
        {history.versions.map((v, i) => {
          const prev = history.versions[i + 1]?.settings ?? history.beforeOldest;
          const changes = describeChanges(prev, v.settings, voiceName);
          const noPrompt = !(v.settings.prompt ?? "").trim();
          const inactive = history.inactiveVoices.includes(v.settings.voiceId);
          const confirmText = [
            `לחזור להגדרות של גרסה ${v.version}?`,
            isCustomer ? "הבוט ב-Vapi יתעדכן מיד, מהשיחה הבאה." : "",
            noPrompt ? "בגרסה הזו לא נשמרו הנחיות, ולכן ההנחיות הנוכחיות יישארו." : "",
            inactive ? `הקול ${voiceName(v.settings.voiceId)} כבוי כרגע בקטלוג.` : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <li key={v.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">גרסה {v.version}</span>
                    {v.current && (
                      <span className="rounded-full bg-call-soft px-2 py-0.5 text-xs text-call-strong">פעילה עכשיו</span>
                    )}
                    <span className="text-sm text-ink-soft">
                      {fmtDateTime(v.createdAt)} · {versionAuthor(v)}
                    </span>
                  </div>
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {changes.map((c) => (
                      <li key={c} className="rounded-md bg-paper px-2 py-0.5 text-xs text-ink-soft">
                        {c}
                      </li>
                    ))}
                  </ul>
                </div>
                {!v.current && (
                  <ActionForm
                    action={restoreVersionAction.bind(null, tenantId, v.id)}
                    submitLabel="לחזור לגרסה הזו"
                    subtle
                    confirmText={confirmText}
                  />
                )}
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-sm text-call hover:underline">להציג את ההגדרות</summary>
                <dl className="mt-2 grid gap-x-4 gap-y-2 rounded-lg bg-paper p-3 text-sm sm:grid-cols-[auto_1fr]">
                  <dt className="text-ink-soft">קול</dt>
                  <dd>
                    {voiceName(v.settings.voiceId)}
                    {inactive && <span className="mr-2 text-xs text-pending">(כבוי בקטלוג)</span>}
                  </dd>
                  <dt className="text-ink-soft">מי מדבר ראשון</dt>
                  <dd>{v.settings.firstSpeaker === "bot" ? "הבוט" : "המתקשר"}</dd>
                  <dt className="text-ink-soft">פתיח</dt>
                  <dd className="whitespace-pre-wrap">{v.settings.openingMessage || "—"}</dd>
                  <dt className="text-ink-soft">משפט סיום</dt>
                  <dd className="whitespace-pre-wrap">{v.settings.closingMessage || "—"}</dd>
                  <dt className="text-ink-soft">הנחיות</dt>
                  <dd>
                    {noPrompt ? (
                      <span className="text-ink-soft">לא נשמרו בגרסה הזו</span>
                    ) : (
                      <div dir="auto" className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface p-2">
                        {v.settings.prompt}
                      </div>
                    )}
                  </dd>
                </dl>
              </details>
            </li>
          );
        })}
      </ol>
      {history.more && <p className="mt-3 text-xs text-ink-soft">מוצגות {history.versions.length} הגרסאות האחרונות.</p>}
    </>
  );
}

/** מתי הדקות והעלות נמשכו מ-Vapi, וקישור לרענון */
function SyncStatus({ detail }: { detail: TenantDetail }) {
  const { syncedAt, syncPending, tenant } = detail;
  if (!tenant.vapiAssistantId && tenant.type !== "demo") return null;
  return (
    <p className="mt-1 text-xs text-ink-soft">
      {syncPending
        ? "השיחות מתעדכנות מ-Vapi ברקע. הדקות והעלות יתעדכנו בטעינה הבאה."
        : `השיחות עודכנו מ-Vapi ${fmtAgo(syncedAt)}.`}{" "}
      <Link href={`/admin/t/${tenant.id}?fresh=1`} prefetch={false} className="text-call hover:underline">
        רענון
      </Link>
    </p>
  );
}

const COST_PARTS = [
  { key: "llmUsd", label: "מודל השפה", hint: "LLM: החשיבה והתשובות של הבוט" },
  { key: "ttsUsd", label: "הקול", hint: "TTS: ElevenLabs, Cartesia וכו'" },
  { key: "sttUsd", label: "תמלול", hint: "STT: הבנת מה שהמתקשר אומר" },
  { key: "transportUsd", label: "טלפוניה", hint: "Twilio, Vonage או המספר של Vapi" },
  { key: "vapiUsd", label: "Vapi", hint: "העמלה של Vapi עצמו" },
  { key: "analysisUsd", label: "ניתוח אחרי השיחה", hint: "סיכום ונתונים שמופקים מהשיחה" },
  { key: "otherUsd", label: "לא מפורט", hint: "שיחות מלפני ששמרנו פירוט, ועלויות קטנות אחרות" },
] as const;

function periodText(detail: TenantDetail): string {
  const { kind, from, to } = detail.costPeriod;
  if (kind === "demo") return "מתחילת הדמו";
  if (kind === "month") {
    return `ב${from.toLocaleDateString("he-IL", { month: "long", year: "numeric", timeZone: "Asia/Jerusalem" })}`;
  }
  return `במחזור הנוכחי (${fmtDate(from)} עד ${fmtDate(to)})`;
}

function CostSection({ detail }: { detail: TenantDetail }) {
  const { cost, previousCostUsd, costError } = detail;
  if (!cost) {
    return (
      <Section title="עלות">
        <p className="rounded-lg bg-pending-soft px-3 py-2 text-sm text-pending">{costError}</p>
      </Section>
    );
  }
  const minutes = cost.seconds / 60;
  const parts = COST_PARTS.map((p) => ({ ...p, value: cost[p.key] })).filter((p) => p.value >= 0.005);

  return (
    <Section title="עלות">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <p className="text-3xl font-semibold tabular-nums" dir="ltr">
            {fmtUsd(cost.totalUsd)}
          </p>
          <p className="text-sm text-ink-soft">{periodText(detail)}</p>
        </div>
        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <div>
            <dt className="text-ink-soft">עלות לדקה</dt>
            <dd className="font-medium tabular-nums" dir="ltr">
              {minutes >= 1 ? fmtUsdRate(cost.totalUsd / minutes) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-ink-soft">שיחות</dt>
            <dd className="font-medium tabular-nums">{cost.pricedCalls}</dd>
          </div>
          {cost.testUsd > 0 && detail.tenant.type !== "demo" && (
            <div>
              <dt className="text-ink-soft">מזה שיחות ניסיון</dt>
              <dd className="font-medium tabular-nums" dir="ltr">
                {fmtUsd(cost.testUsd)}
              </dd>
            </div>
          )}
          {previousCostUsd != null && (
            <div>
              <dt className="text-ink-soft">בתקופה הקודמת</dt>
              <dd className="font-medium tabular-nums" dir="ltr">
                {fmtUsd(previousCostUsd)}
              </dd>
            </div>
          )}
        </dl>
      </div>

      {parts.length > 0 ? (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="border-b border-line text-right text-ink-soft">
                <th className="py-2 font-medium">על מה</th>
                <th className="py-2 font-medium">סכום</th>
                <th className="py-2 font-medium">מתוך הכול</th>
              </tr>
            </thead>
            <tbody>
              {parts.map((p) => (
                <tr key={p.key} className="border-b border-line last:border-0">
                  <td className="py-2">
                    {p.label} <span className="text-xs text-ink-soft">{p.hint}</span>
                  </td>
                  <td className="py-2 tabular-nums">
                    <bdi dir="ltr">{fmtUsd(p.value)}</bdi>
                  </td>
                  <td className="py-2 tabular-nums">{Math.round((p.value / cost.totalUsd) * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-4 text-sm text-ink-soft">עוד אין שיחות עם מחיר בתקופה הזו.</p>
      )}

      <p className="mt-4 text-xs text-ink-soft">
        הסכומים הם מה ש-Vapi מדווח על כל שיחה, בדולרים, כולל שיחות ניסיון ושיחות שלא נענו. ספק שמחובר ב-Vapi עם
        מפתח משלך (למשל ElevenLabs, או מספר Twilio משלך) עשוי לחייב אותך ישירות, ואז החלק שלו לא נכלל כאן.
      </p>
    </Section>
  );
}

async function ConvertSection({ tenantId, fresh }: { tenantId: string; fresh: boolean }) {
  const options = await vapiOptions({ fresh });
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
          <div>
            <Field label="ה-assistant של הלקוח">
              <AssistantSelect options={options} name="assistantId" required />
            </Field>
            <RefreshVapiLink path={`/admin/t/${tenantId}`} />
          </div>
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
