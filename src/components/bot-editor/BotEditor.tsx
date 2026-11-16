"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiRequestError, createBotApi } from "@/lib/api";
import type { BotPageData, BotSettings, CustomerVersion, FieldErrors } from "@/lib/types";
import { hasErrors, sameSettings, validateSettings } from "@/lib/validation";
import { ActionBar, formatDuration, type Notice } from "./ActionBar";
import { CallFlow } from "./CallFlow";
import { ComingSoon } from "./ComingSoon";
import { UsageCard } from "./UsageCard";
import { cn } from "./cn";
import { VersionsPanel } from "./VersionsPanel";
import {
  BackgroundPicker,
  ResponseStylePicker,
  SPEECH_RATE_LABELS,
  StepSlider,
  VOLUME_LABELS,
} from "./ConversationStyle";
import { NO_FEATURES, withCurrentStyle, withoutClosed } from "@/lib/conversation-style";
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
  // גרסה קודמת שהוחזרה למסך. אם הלקוח מעדכן אותה כמו שהיא, ההיסטוריה תגיד "חזרה לגרסה N".
  const [restored, setRestored] = useState<{ version: number; settings: BotSettings } | null>(null);
  const [versionsKey, setVersionsKey] = useState(0);

  const dirty = !sameSettings(published, draft);
  const voiceIds = useMemo(() => voices.map((v) => v.id), [voices]);
  const selectedVoice = voices.find((v) => v.id === draft.voiceId) ?? voices[0];
  const features = initialData.features ?? NO_FEATURES;

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
    const found = validateSettings(draft, voiceIds, initialData.promptMax);
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
    const restoredFrom = restored && sameSettings(restored.settings, sent) ? restored.version : undefined;
    setBusy("update");
    setNotice(null);
    try {
      // published = ההגדרות שהשרת מסר לנו. לפיהן הוא כותב ל-Vapi רק את מה שהלקוח שינה.
      const res = await botApi.update(sent, published, restoredFrom);
      setPublished(res.settings);
      // אם הלקוח המשיך להקליד בזמן העדכון, לא דורסים את מה שהוא כתב
      setDraft((current) => (sameSettings(current, sent) ? res.settings : current));
      setLastUpdatedAt(res.lastUpdatedAt);
      setRestored(null);
      setVersionsKey((k) => k + 1);
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

  /**
   * מחזיר גרסה קודמת למסך. הבוט עצמו לא משתנה עד "עדכן את הבוט".
   * גרסה בלי הנחיות לא מוחקת את ההנחיות שעל המסך, וקול שכבר לא זמין מוחלף בקול שנבחר עכשיו.
   */
  function restoreVersion(v: CustomerVersion) {
    const voiceAvailable = voiceIds.includes(v.settings.voiceId);
    const next: BotSettings = {
      // גרסה ישנה בלי סגנון שיחה: נשאר מה שעל המסך
      ...withoutClosed(withCurrentStyle(v.settings, draft), features),
      voiceId: voiceAvailable ? v.settings.voiceId : draft.voiceId,
      prompt: v.settings.prompt?.trim() ? v.settings.prompt : draft.prompt,
    };
    setDraft(next);
    setErrors({});
    setRestored({ version: v.version, settings: next });
    setNotice({
      tone: "info",
      content:
        `ההגדרות של גרסה ${v.version} חזרו למסך. הבוט עוד לא השתנה: אפשר לנסות אותו, ואז ללחוץ "עדכן את הבוט".` +
        (voiceAvailable ? "" : ` הקול ${v.voiceName} כבר לא זמין, אז נשאר הקול שבחרת.`),
    });
    document.getElementById("flow-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /** מבטל את מה שעל המסך וחוזר למה שהבוט עובד איתו */
  function discardChanges() {
    setDraft(published);
    setErrors({});
    setRestored(null);
    setNotice(null);
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
            <p className="mt-1 max-w-prose text-ink-soft">מה הבוט אומר מהרגע שהוא עונה ועד שהשיחה נגמרת.</p>
            <div className="mt-6">
              <CallFlow
                settings={draft}
                voice={selectedVoice}
                voices={voices}
                errors={errors}
                promptMax={initialData.promptMax}
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
            <div className={cn("mt-8 flex flex-col gap-6", !features.speechRate && !features.volume && "hidden")}>
              {features.speechRate && (
                <StepSlider
                  id="speech-rate"
                  label="קצב דיבור"
                  labels={SPEECH_RATE_LABELS}
                  value={draft.speechRate}
                  onChange={(v) => change("speechRate", v)}
                />
              )}
              {features.volume && (
                <StepSlider
                  id="volume"
                  label="עוצמת קול"
                  labels={VOLUME_LABELS}
                  value={selectedVoice?.supportsVolume ? draft.volume : 0}
                  onChange={(v) => change("volume", v)}
                  disabledNote={
                    selectedVoice?.supportsVolume
                      ? undefined
                      : "בקול הזה אי אפשר לשנות עוצמה. בקולות אחרים ברשימה אפשר."
                  }
                />
              )}
            </div>
          </section>
        </div>

        {/* רק מה שהאדמין פתח ללקוח הזה */}
        {(features.responseStyle || features.backgroundSound) && (
          <section aria-labelledby="style-title" className="mt-16">
            <h2 id="style-title" className="text-xl font-semibold">
              סגנון השיחה
            </h2>
            <div className="mt-6 grid gap-8 md:grid-cols-2">
              {features.responseStyle && (
                <ResponseStylePicker value={draft.responseStyle} onChange={(v) => change("responseStyle", v)} />
              )}
              {features.backgroundSound && (
                <BackgroundPicker value={draft.backgroundSound} onChange={(v) => change("backgroundSound", v)} />
              )}
            </div>
          </section>
        )}

        <section aria-labelledby="versions-title" className="mt-16">
          <h2 id="versions-title" className="text-xl font-semibold">
            גרסאות קודמות
          </h2>
          <p className="mt-1 text-ink-soft">כל עדכון של הבוט נשמר. אפשר להחזיר גרסה קודמת למסך, לנסות אותה ולעדכן.</p>
          <div className="mt-4">
            <VersionsPanel
              api={botApi}
              reloadKey={versionsKey}
              dirty={dirty}
              onRestore={restoreVersion}
              onDiscard={discardChanges}
            />
          </div>
        </section>

        <section aria-labelledby="soon-title" className="mt-16">
          <h2 id="soon-title" className="text-xl font-semibold">
            בקרוב
          </h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <ComingSoon title="השיחות שלכם" description="מי התקשר, מה נאמר בשיחה וסיכום קצר של כל פנייה." />
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
