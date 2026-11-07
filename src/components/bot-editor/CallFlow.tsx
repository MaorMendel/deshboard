"use client";

import { MessagesSquare, PhoneIncoming, PhoneOff, UserRound, AudioLines } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import type { BotSettings, FieldErrors, FirstSpeaker, Voice } from "@/lib/types";
import { CLOSING_MAX, OPENING_MAX } from "@/lib/validation";
import { cn } from "./cn";

interface CallFlowProps {
  settings: BotSettings;
  voice: Voice;
  voices: Voice[];
  errors: FieldErrors;
  /** אורך מקסימלי להנחיות, מהשרת */
  promptMax: number;
  onChange: <K extends keyof BotSettings>(key: K, value: BotSettings[K]) => void;
}

export function CallFlow({ settings, voice, voices, errors, promptMax, onChange }: CallFlowProps) {
  const callerFirst = settings.firstSpeaker === "caller";

  return (
    <ol className="relative">
      <Step icon={PhoneIncoming} title="הטלפון מצלצל">
        <p className="mb-3 text-ink-soft">מי מדבר ראשון כשהבוט עונה?</p>
        <SpeakerToggle
          value={settings.firstSpeaker}
          voice={voice}
          onChange={(v) => onChange("firstSpeaker", v)}
          error={errors.firstSpeaker}
        />
      </Step>

      {callerFirst && (
        <Step icon={UserRound} title="המתקשר מדבר">
          <div className="flex justify-end">
            <p className="max-w-xs rounded-2xl rounded-se-md bg-caller px-4 py-3 text-ink">שלום?</p>
          </div>
          <p className="mt-2 text-sm text-ink-soft">הבוט שותק עד שהמתקשר אומר משהו.</p>
        </Step>
      )}

      <Step icon={AudioLines} title="פתיח">
        <BotLine
          id="opening"
          voice={voice}
          voices={voices}
          value={settings.openingMessage}
          max={OPENING_MAX}
          error={errors.openingMessage}
          placeholder="שלום, הגעתם ל... איך אפשר לעזור?"
          hint={
            callerFirst
              ? "אפשר להשאיר ריק."
              : "אם משאירים ריק, הבוט פותח במשפט שהוא מחבר בעצמו לפי ההנחיות שלמטה."
          }
          onChange={(v) => onChange("openingMessage", v)}
        />
      </Step>

      <Step icon={MessagesSquare} title="השיחה עצמה">
        <PromptEditor
          value={settings.prompt ?? ""}
          max={promptMax}
          error={errors.prompt}
          onChange={(v) => onChange("prompt", v)}
        />
      </Step>

      <Step icon={PhoneOff} title="סגירה" last>
        <BotLine
          id="closing"
          voice={voice}
          voices={voices}
          value={settings.closingMessage}
          max={CLOSING_MAX}
          error={errors.closingMessage}
          placeholder="תודה שהתקשרתם, יום טוב"
          hint="הבוט אומר את זה כשהוא מסיים את השיחה בעצמו. אם משאירים ריק, הוא מנתק בלי משפט סיום."
          onChange={(v) => onChange("closingMessage", v)}
        />
      </Step>
    </ol>
  );
}

/**
 * ההנחיות לבוט: מה הוא יודע על העסק ואיך הוא מתנהג בשיחה.
 * טקסט חופשי שנשלח ל-Vapi כהודעת system. תמיד גלוי, בתיבה בגובה קבוע עם גלילה, כמו הפתיח והסגירה:
 * כשזה היה קישור מקופל, לקוחות לא שמו לב שאפשר לערוך את ההנחיות.
 */
function PromptEditor({
  value,
  max,
  error,
  onChange,
}: {
  value: string;
  max: number;
  error?: string;
  onChange: (v: string) => void;
}) {
  const length = value.trim().length;
  const over = length > max;

  return (
    <div>
      <div
        className={cn(
          "rounded-2xl border bg-surface px-4 pb-2 pt-3 transition-colors",
          error ? "border-danger" : "border-line focus-within:border-call focus-within:shadow-[0_0_0_1px_var(--color-call)]",
        )}
      >
        <label htmlFor="prompt" className="block text-sm text-ink-soft">
          ההנחיות של הבוט
        </label>
        <textarea
          id="prompt"
          data-in-card
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={6}
          dir="auto"
          placeholder="לדוגמה: אנחנו מספרה בתל אביב, פתוחים א׳-ה׳ 9:00-19:00. תספורת גברים 80 ₪. כשמישהו רוצה לקבוע תור, תשאל שם ושעה מועדפת."
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "prompt-error prompt-hint" : "prompt-hint"}
          className="mt-1 block h-40 max-h-[70vh] min-h-24 w-full resize-y overflow-y-auto bg-transparent leading-relaxed text-ink outline-none placeholder:text-ink-soft/70"
        />
        <div className="mt-1 flex justify-end">
          <span className={cn("text-xs tabular-nums", over ? "text-danger" : "text-ink-soft")}>
            <bdi dir="ltr">
              {length.toLocaleString("he-IL")}/{max.toLocaleString("he-IL")}
            </bdi>
          </span>
        </div>
      </div>
      {error && (
        <p id="prompt-error" className="mt-2 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      <p id="prompt-hint" className="mt-2 text-sm text-ink-soft">
        מה הבוט יודע על העסק ואיך הוא מתנהג בשיחה. כותבים בשפה חופשית, כמו הסבר לעובד חדש. אפשר לגלול בתוך התיבה,
        ולמשוך את הפינה כדי להגדיל אותה.
      </p>
    </div>
  );
}

function Step({
  icon: Icon,
  title,
  last,
  children,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: string;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <li className={cn("relative ps-12", !last && "pb-9")}>
      {!last && <span aria-hidden className="absolute start-4 top-9 bottom-0 w-px bg-line-strong" />}
      <span
        aria-hidden
        className="absolute start-0 top-0 grid size-8 place-items-center rounded-full border border-line-strong bg-surface text-call"
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <h3 className="mb-3 font-medium leading-8">{title}</h3>
      {children}
    </li>
  );
}

function SpeakerToggle({
  value,
  voice,
  error,
  onChange,
}: {
  value: FirstSpeaker;
  voice: Voice;
  error?: string;
  onChange: (v: FirstSpeaker) => void;
}) {
  const options: { value: FirstSpeaker; label: string; detail: string }[] = [
    {
      value: "bot",
      label: "הבוט",
      detail: voice.gender === "female" ? `${voice.name} עונה ומיד אומרת את הפתיח` : `${voice.name} עונה ומיד אומר את הפתיח`,
    },
    { value: "caller", label: "המתקשר", detail: "הבוט מחכה שהמתקשר ידבר קודם" },
  ];

  return (
    <fieldset>
      <legend className="sr-only">מי מדבר ראשון</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              "cursor-pointer rounded-xl border px-4 py-3 transition-colors",
              "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-call",
              value === o.value ? "border-call bg-call-soft" : "border-line bg-surface hover:border-line-strong",
            )}
          >
            <input
              type="radio"
              name="first-speaker"
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            <span className={cn("block font-medium", value === o.value && "text-call-strong")}>
              {o.label}
            </span>
            <span className="mt-0.5 block text-sm text-ink-soft">{o.detail}</span>
          </label>
        ))}
      </div>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </fieldset>
  );
}

function BotLine({
  id,
  voice,
  voices,
  value,
  max,
  error,
  placeholder,
  hint,
  onChange,
}: {
  id: string;
  voice: Voice;
  voices: Voice[];
  value: string;
  max: number;
  error?: string;
  placeholder: string;
  hint?: string;
  onChange: (v: string) => void;
}) {
  const length = value.trim().length;
  const over = length > max;
  // הפתיח אומר "מדברת נועה" אבל הקול שנבחר הוא איתי? כדאי לשים לב.
  const otherNames = voices.filter((v) => v.id !== voice.id && value.includes(v.name)).map((v) => v.name);
  const speaks = voice.gender === "female" ? "אומרת" : "אומר";
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <div>
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-full bg-call-soft font-medium text-call-strong"
        >
          {voice.name.charAt(0)}
        </span>
        <div
          className={cn(
            "min-w-0 flex-1 rounded-2xl rounded-ss-md border bg-surface px-4 pb-2 pt-3 transition-colors",
            error
              ? "border-danger"
              : "border-line focus-within:border-call focus-within:shadow-[0_0_0_1px_var(--color-call)]",
          )}
        >
          <label htmlFor={id} className="block text-sm text-ink-soft">
            {voice.name} {speaks}
          </label>
          <textarea
            id={id}
            data-in-card
            value={value}
            rows={2}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={[hint && hintId, error && errorId].filter(Boolean).join(" ") || undefined}
            className="mt-1 block w-full resize-none bg-transparent text-[17px] leading-relaxed text-ink outline-none placeholder:text-ink-soft/70 [field-sizing:content] min-h-[3.5rem]"
          />
          <div className="mt-1 flex justify-end">
            <span className={cn("text-xs tabular-nums", over ? "text-danger" : "text-ink-soft")}>
              <bdi dir="ltr">
                {length}/{max}
              </bdi>
            </span>
          </div>
        </div>
      </div>

      <div className="ps-12">
        {error && (
          <p id={errorId} className="mt-2 text-sm text-danger">
            {error}
          </p>
        )}
        {!error && otherNames.length > 0 && (
          <p className="mt-2 rounded-lg bg-pending-soft px-3 py-2 text-sm text-pending">
            הטקסט מזכיר את השם {otherNames.join(", ")}, אבל הקול שנבחר הוא {voice.name}.
          </p>
        )}
        {hint && (
          <p id={hintId} className="mt-2 text-sm text-ink-soft">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}
