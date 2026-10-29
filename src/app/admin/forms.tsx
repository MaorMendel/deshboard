"use client";

// הטפסים של פאנל הניהול. כל טופס מפעיל server action מ-actions.ts ומציג את התוצאה.

import { Check, Copy } from "lucide-react";
import { useActionState, useState } from "react";
import type { ActionResult } from "./actions";

type FormAction = (prev: ActionResult, form: FormData) => Promise<ActionResult>;

export const inputCls =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-ink placeholder:text-ink-soft/60 focus:border-call";
export const btnCls = "rounded-lg bg-call px-4 py-2 font-medium text-white hover:bg-call-strong disabled:opacity-50";
export const btnSubtleCls =
  "rounded-lg border border-line-strong bg-surface px-4 py-2 font-medium text-ink hover:border-call disabled:opacity-50";

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-soft">{hint}</span>}
    </label>
  );
}

/** כפתור "העתק", עם סימון הצלחה לשתי שניות */
function CopyButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="grid size-8 shrink-0 place-items-center rounded-md border border-line-strong bg-surface hover:border-call"
      aria-label={copied ? "הקישור הועתק" : "העתקת הקישור"}
      onClick={() => {
        navigator.clipboard.writeText(url).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? <Check className="size-4 text-call" aria-hidden /> : <Copy className="size-4" aria-hidden />}
    </button>
  );
}

/** קישור חד-פעמי, בולט, אחרי יצירה או הנפקה */
function OneTimeUrl({ url }: { url: string }) {
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg border border-call bg-call-soft p-2">
      <code dir="ltr" className="min-w-0 flex-1 break-all text-sm">
        {url}
      </code>
      <CopyButton url={url} />
    </div>
  );
}

/**
 * קישור קיים בטבלת הקישורים. מוצג מקוצר כדי שלא יתפוס את כל השורה,
 * ועם כפתור שמעתיק את הקישור המלא.
 */
export function CopyLink({ url }: { url: string }) {
  const [shown, setShown] = useState(false);
  const key = url.split("/b/")[1] ?? url;
  return (
    <span className="flex items-center gap-1.5">
      {shown ? (
        <code dir="ltr" className="max-w-56 truncate text-xs" title={url}>
          {url}
        </code>
      ) : (
        <button type="button" onClick={() => setShown(true)} className="text-xs text-call hover:underline">
          להציג ({key.slice(0, 6)}…)
        </button>
      )}
      <CopyButton url={url} />
    </span>
  );
}

function Feedback({ result }: { result: ActionResult }) {
  if (!result) return null;
  if (result.error) {
    return (
      <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
        {result.error}
      </p>
    );
  }
  return (
    <div role="status" className="text-sm">
      <p className="rounded-lg bg-call-soft px-3 py-2 text-call-strong">{result.ok}</p>
      {result.url && <OneTimeUrl url={result.url} />}
    </div>
  );
}

/** עוטף טופס: מחבר action, מציג תוצאה וכפתור שליחה */
export function ActionForm({
  action,
  submitLabel,
  children,
  subtle,
}: {
  action: FormAction;
  submitLabel: string;
  children?: React.ReactNode;
  subtle?: boolean;
}) {
  const [result, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      {children}
      <Feedback result={result} />
      <div>
        <button type="submit" disabled={pending} className={subtle ? btnSubtleCls : btnCls}>
          {pending ? "רגע..." : submitLabel}
        </button>
      </div>
    </form>
  );
}

export function LoginForm({ action }: { action: FormAction }) {
  return (
    <ActionForm action={action} submitLabel="כניסה">
      <Field label="סיסמת ניהול">
        <input name="password" type="password" required autoFocus className={inputCls} dir="ltr" />
      </Field>
    </ActionForm>
  );
}

/** כפתור לפעולה בלי שדות (ביטול קישורים, השעיה), עם אישור לפני */
export function ConfirmButton({
  action,
  label,
  confirmText,
  danger,
}: {
  action: () => Promise<void>;
  label: string;
  confirmText: string;
  danger?: boolean;
}) {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      className={danger ? `${btnSubtleCls} border-danger text-danger hover:border-danger` : btnSubtleCls}
      onClick={async () => {
        if (!window.confirm(confirmText)) return;
        setPending(true);
        try {
          await action();
        } finally {
          setPending(false);
        }
      }}
    >
      {pending ? "רגע..." : label}
    </button>
  );
}
