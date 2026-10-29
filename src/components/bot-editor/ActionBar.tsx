"use client";

import { AlertCircle, CheckCircle2, LoaderCircle, PhoneCall } from "lucide-react";
import type { ReactNode } from "react";
import type { PlanInfo } from "@/lib/types";
import { cn } from "./cn";

export interface Notice {
  tone: "success" | "error" | "info";
  content: ReactNode;
}

interface ActionBarProps {
  dirty: boolean;
  busy: null | "update" | "test";
  notice: Notice | null;
  plan: PlanInfo;
  lastUpdatedAt: string | null;
  onTest: () => void;
  onUpdate: () => void;
}

const timeFormat = new Intl.DateTimeFormat("he-IL", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Jerusalem",
});
const dateFormat = new Intl.DateTimeFormat("he-IL", {
  day: "numeric",
  month: "long",
  timeZone: "Asia/Jerusalem",
});

/** 200 -> "3:20 דקות", 45 -> "45 שניות" */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} שניות`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? (m === 1 ? "דקה" : `${m} דקות`) : `${m}:${String(rest).padStart(2, "0")} דקות`;
}

function describeDemo(plan: Extract<PlanInfo, { type: "demo" }>): string {
  const ends = new Date(plan.expiresAt).toLocaleDateString("he-IL", { day: "numeric", month: "long", timeZone: "Asia/Jerusalem" });
  return plan.remainingSeconds > 0
    ? `דמו: נשארו ${formatDuration(plan.remainingSeconds)} של שיחות ניסיון, עד ${ends}.`
    : "דמו: נגמר זמן שיחות הניסיון. כדאי לפנות אלינו כדי להמשיך.";
}

function describeLastUpdate(iso: string | null): string {
  if (!iso) return "הבוט עובד עם ההגדרות שעל המסך.";
  const date = new Date(iso);
  const sameDay = dateFormat.format(date) === dateFormat.format(new Date());
  return sameDay
    ? `הבוט מעודכן. עדכון אחרון היום ב-${timeFormat.format(date)}.`
    : `הבוט מעודכן. עדכון אחרון ב-${dateFormat.format(date)}.`;
}

export function ActionBar({ dirty, busy, notice, plan, lastUpdatedAt, onTest, onUpdate }: ActionBarProps) {
  return (
    <div className="sticky bottom-0 z-10 border-t border-line bg-paper/95 backdrop-blur-sm">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:px-6">
        <div aria-live="polite" className="min-h-6 flex-1 text-sm">
          {notice ? (
            <NoticeLine notice={notice} />
          ) : dirty ? (
            <span className="inline-flex items-center gap-2 text-pending">
              <span aria-hidden className="size-2 rounded-full bg-pending" />
              יש שינויים שעוד לא עודכנו בבוט.
            </span>
          ) : plan.type === "demo" ? (
            <span className="text-ink-soft">{describeDemo(plan)}</span>
          ) : (
            <span className="text-ink-soft">{describeLastUpdate(lastUpdatedAt)}</span>
          )}
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onTest}
            disabled={busy !== null}
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-line-strong bg-surface px-5 font-medium text-ink transition-colors hover:border-call disabled:cursor-wait disabled:opacity-70 sm:flex-none"
          >
            {busy === "test" ? (
              <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />
            ) : (
              <PhoneCall className="size-4 text-call" aria-hidden />
            )}
            {busy === "test" ? "מתקשר…" : "נסה את הבוט"}
          </button>
          <button
            type="button"
            onClick={onUpdate}
            disabled={busy !== null}
            className={cn(
              "inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border px-5 font-medium transition-colors disabled:cursor-wait disabled:opacity-70 sm:flex-none",
              dirty
                ? "border-call bg-call text-white hover:bg-call-strong"
                : "border-line-strong bg-surface text-ink hover:border-call",
            )}
          >
            {busy === "update" && <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />}
            {busy === "update" ? "מעדכן…" : "עדכן את הבוט"}
          </button>
        </div>
      </div>
    </div>
  );
}

function NoticeLine({ notice }: { notice: Notice }) {
  const Icon = notice.tone === "success" ? CheckCircle2 : notice.tone === "error" ? AlertCircle : null;
  return (
    <span
      className={cn(
        "inline-flex items-start gap-2",
        notice.tone === "success" && "text-call-strong",
        notice.tone === "error" && "text-danger",
        notice.tone === "info" && "text-ink-soft",
      )}
    >
      {Icon && <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />}
      <span>{notice.content}</span>
    </span>
  );
}
