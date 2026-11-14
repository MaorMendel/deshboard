"use client";

// סגנון השיחה בדף של הלקוח: קצב מענה, רעשי רקע, קצב דיבור ועוצמה.
// כל הבחירות כאן הן אפשרויות קבועות. המספרים שנשלחים ל-Vapi נקבעים בשרת.

import { Check } from "lucide-react";
import {
  BACKGROUND_LABELS,
  RESPONSE_STYLES,
  SPEECH_RATE_LABELS,
  STEPS,
  VOLUME_LABELS,
  type BackgroundSound,
  type ResponseStyle,
  type Step,
} from "@/lib/conversation-style";
import { cn } from "./cn";

function OptionCard({
  name,
  checked,
  onChange,
  title,
  description,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  title: string;
  description?: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3 transition-colors",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-call",
        checked ? "border-call bg-call-soft" : "border-line bg-surface hover:border-line-strong",
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onChange} className="sr-only" />
      <span className="min-w-0 flex-1">
        <span className={cn("block font-medium", checked && "text-call-strong")}>{title}</span>
        {description && <span className="mt-0.5 block text-sm text-ink-soft">{description}</span>}
      </span>
      <Check aria-hidden className={cn("mt-0.5 size-5 shrink-0 text-call", checked ? "opacity-100" : "opacity-0")} />
    </label>
  );
}

export function ResponseStylePicker({
  value,
  onChange,
}: {
  value: ResponseStyle | null | undefined;
  onChange: (v: ResponseStyle) => void;
}) {
  return (
    <fieldset>
      <legend className="font-medium">קצב מענה</legend>
      <p className="mt-0.5 text-sm text-ink-soft">כמה זמן הבוט מחכה אחרי שהמתקשר מסיים לדבר, לפני שהוא עונה.</p>
      <div className="mt-3 grid gap-3">
        {(["fast", "patient"] as const).map((s) => (
          <OptionCard
            key={s}
            name="responseStyle"
            checked={value === s}
            onChange={() => onChange(s)}
            title={RESPONSE_STYLES[s].title}
            description={RESPONSE_STYLES[s].description}
          />
        ))}
      </div>
      {!value && <p className="mt-2 text-sm text-ink-soft">עוד לא נבחר. עד שבוחרים, הבוט עונה כמו שהוגדר לו.</p>}
    </fieldset>
  );
}

export function BackgroundPicker({
  value,
  onChange,
}: {
  value: BackgroundSound | undefined;
  onChange: (v: BackgroundSound) => void;
}) {
  const current = value ?? "office";
  return (
    <fieldset>
      <legend className="font-medium">רעשי רקע</legend>
      <p className="mt-0.5 text-sm text-ink-soft">רעשי משרד שקטים ברקע גורמים לשיחה להישמע טבעית יותר.</p>
      <div className="mt-3 grid gap-3">
        {(["office", "off"] as const).map((b) => (
          <OptionCard
            key={b}
            name="backgroundSound"
            checked={current === b}
            onChange={() => onChange(b)}
            title={BACKGROUND_LABELS[b]}
          />
        ))}
      </div>
    </fieldset>
  );
}

/** בחירה של דרגה מ-2- עד 2 במחוון. 0 = כמו שהקול מוגדר. */
export function StepSlider({
  id,
  label,
  labels,
  value,
  onChange,
  disabledNote,
}: {
  id: string;
  label: string;
  labels: Record<Step, string>;
  value: Step | undefined;
  onChange: (v: Step) => void;
  /** כשמוגדר: המחוון לא פעיל, וההסבר מוצג במקומו */
  disabledNote?: string;
}) {
  const current = value ?? 0;
  const disabled = Boolean(disabledNote);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="font-medium">
          {label}
        </label>
        {!disabled && <span className="text-sm text-call-strong">{labels[current]}</span>}
      </div>
      <input
        id={id}
        type="range"
        min={STEPS[0]}
        max={STEPS[STEPS.length - 1]}
        step={1}
        value={current}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value) as Step)}
        aria-valuetext={labels[current]}
        className="mt-2 w-full accent-[var(--color-call)] disabled:opacity-40"
      />
      <div className="flex justify-between text-xs text-ink-soft" aria-hidden>
        <span>{labels[-2]}</span>
        <span>{labels[2]}</span>
      </div>
      {disabledNote && <p className="mt-1 text-sm text-ink-soft">{disabledNote}</p>}
    </div>
  );
}

export { SPEECH_RATE_LABELS, VOLUME_LABELS };
