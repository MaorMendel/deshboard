"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiRequestError, createBotApi } from "@/lib/api";
import type { BotPageData, BotSettings, FieldErrors } from "@/lib/types";
import { hasErrors, sameSettings, validateSettings } from "@/lib/validation";
import { ActionBar, formatDuration, type Notice } from "./ActionBar";
import { CallFlow } from "./CallFlow";
import { ComingSoon } from "./ComingSoon";
import { UsageCard } from "./UsageCard";
import { VoicePicker } from "./VoicePicker";

type Busy = null | "update" | "test";

export function BotEditor({ accessKey, initialData }: { accessKey: string; initialData: BotPageData }) {
  const { business, voices } = initialData;
  const botApi = useMemo(() => createBotApi(accessKey), [accessKey]);
  const [plan, setPlan] = useState(initialData.plan);

  // published = מה שהבוט החי עובד איתו. draft = מה שעל המסך.
  const [published, setPublished] = useState<BotSettings>(initialData.settings);
  const [draft, setDraft] = useState<BotSettings>(initialData.settings);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(initialData.lastUpdatedAt);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const dirty = !sameSettings(published, draft);
  const voiceIds = useMemo(() => voices.map((v) => v.id), [voices]);
  const selectedVoice = voices.find((v) => v.id === draft.voiceId) ?? voices[0];

  // אזהרה לפני יציאה מהדף עם שינויים שלא עודכנו
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // הודעות הצלחה נעלמות לבד, שגיאות נשארות עד הפעולה הבאה
  useEffect(() => {
    if (notice?.tone !== "success") return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  function change<K extends keyof BotSettings>(key: K, value: BotSettings[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    if (errors[key]) {
      setErrors((e) => {
        const next = { ...e };
        delete next[key];
        return next;
      });
    }
  }

  function passesLocalCheck(): boolean {
    const found = validateSettings(draft, voiceIds);
    setErrors(found);
    if (hasErrors(found)) {
      setNotice({ tone: "error", content: "יש שדות שצריך לתקן לפני שממשיכים." });
      return false;
    }
    return true;
  }

  function showApiError(err: unknown) {
    if (err instanceof ApiRequestError) {
      if (err.body.fieldErrors) setErrors(err.body.fieldErrors);
      setNotice({ tone: "error", content: err.body.message });
    } else {
      setNotice({ tone: "error", content: "משהו השתבש. אפשר לנסות שוב." });
    }
  }

  async function handleUpdate() {
    if (busy) return;
    if (!dirty) {
      setNotice({ tone: "info", content: "אין שינויים לעדכן. הבוט כבר עובד עם מה שעל המסך." });
      return;
    }
    if (!passesLocalCheck()) return;

    const sent = draft;
    setBusy("update");
    setNotice(null);
    try {
      // published = ההגדרות שהשרת מסר לנו. לפיהן הוא כותב ל-Vapi רק את מה שהלקוח שינה.
      const res = await botApi.update(sent, published);
      setPublished(res.settings);
      // אם הלקוח המשיך להקליד בזמן העדכון, לא דורסים את מה שהוא כתב
      setDraft((current) => (sameSettings(current, sent) ? res.settings : current));
      setLastUpdatedAt(res.lastUpdatedAt);
      setNotice({
        tone: "success",
        content:
          plan.type === "demo"
            ? "ההגדרות נשמרו. שיחת הניסיון הבאה תשתמש בהן."
            : "הבוט עודכן. השינויים פעילים מהשיחה הבאה.",
      });
    } catch (err) {
      showApiError(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleTest() {
    if (busy) return;
    if (!passesLocalCheck()) return;

    const includesUnpublished = dirty;
    setBusy("test");
    setNotice(null);
    try {
      const res = await botApi.testCall(draft);
      if (res.demoRemainingSeconds !== null && plan.type === "demo") {
        setPlan({ ...plan, remainingSeconds: res.demoRemainingSeconds });
      }
      const content: ReactNode = (
        <>
          מתקשרים אליך עכשיו ל-<bdi dir="ltr">{res.calledNumberMasked}</bdi>.{" "}
          {includesUnpublished && "השיחה כוללת את השינויים שעוד לא עודכנו. "}
          {res.demoRemainingSeconds !== null &&
            `השיחה תתנתק אחרי ${formatDuration(res.demoRemainingSeconds)}, כשנגמר זמן הדמו.`}
        </>
      );
      setNotice({ tone: "success", content });
    } catch (err) {
      showApiError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-16 pt-10 sm:px-6">
        <header className="border-b border-line pb-6">
          <h1 className="text-[28px] font-semibold leading-tight">{business.name}</h1>
          {business.botPhoneDisplay ? (
            <p className="mt-1 text-ink-soft">
              הבוט שעונה ב-<bdi dir="ltr">{business.botPhoneDisplay}</bdi>
            </p>
          ) : (
            <p className="mt-1 text-ink-soft">{plan.type === "demo" ? "דמו של הבוט שלכם" : "הבוט של העסק"}</p>
          )}
        </header>

        {plan.type === "customer" && plan.usage && <UsageCard usage={plan.usage} />}

        <div className="grid gap-12 pt-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-14">
          <section aria-labelledby="flow-title">
            <h2 id="flow-title" className="text-xl font-semibold">
              מהלך השיחה
            </h2>
            <p className="mt-1 max-w-prose text-ink-soft">
              מה הבוט אומר מהרגע שהוא עונה ועד שהשיחה נגמרת.
            </p>
            <div className="mt-6">
              <CallFlow
                settings={draft}
                voice={selectedVoice}
                voices={voices}
                errors={errors}
                onChange={change}
              />
            </div>
          </section>

          <section aria-labelledby="voice-title">
            <h2 id="voice-title" className="text-xl font-semibold">
              הקול של הבוט
            </h2>
            <p className="mt-1 text-ink-soft">כל הקולות נבדקו בעברית.</p>
            <div className="mt-6">
              <VoicePicker
                voices={voices}
                selectedId={draft.voiceId}
                error={errors.voiceId}
                onSelect={(id) => change("voiceId", id)}
              />
            </div>
          </section>
        </div>

        <section aria-labelledby="soon-title" className="mt-16">
          <h2 id="soon-title" className="text-xl font-semibold">
            בקרוב
          </h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <ComingSoon
              title="גרסאות קודמות"
              description="היסטוריה של כל עדכון, וחזרה לגרסה קודמת בלחיצה אחת."
            />
            <ComingSoon
              title="השיחות שלכם"
              description="מי התקשר, מה נאמר בשיחה וסיכום קצר של כל פנייה."
            />
          </div>
        </section>
      </main>

      <ActionBar
        dirty={dirty}
        busy={busy}
        notice={notice}
        plan={plan}
        lastUpdatedAt={lastUpdatedAt}
        onTest={handleTest}
        onUpdate={handleUpdate}
      />
    </div>
  );
}
