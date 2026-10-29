import type { CustomerUsage } from "@/lib/types";

/** מונה הדקות של לקוח משלם: כמה נוצל מהחבילה במחזור הנוכחי */
export function UsageCard({ usage }: { usage: CustomerUsage }) {
  const over = usage.usedMinutes >= usage.limitMinutes;
  const percent = Math.min(100, Math.round((usage.usedMinutes / usage.limitMinutes) * 100));
  const renews = new Date(usage.renewsAt).toLocaleDateString("he-IL", {
    day: "numeric",
    month: "long",
    timeZone: "Asia/Jerusalem",
  });

  return (
    <section aria-label="ניצול החבילה" className="mt-6 rounded-2xl border border-line bg-surface px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">
          ניצלתם{" "}
          <span className={over ? "text-danger" : "text-call-strong"}>
            {usage.usedMinutes.toLocaleString("he-IL")}
          </span>{" "}
          מתוך {usage.limitMinutes.toLocaleString("he-IL")} דקות החבילה
        </p>
        <p className="text-sm text-ink-soft">המונה מתאפס ב-{renews}</p>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-caller" role="presentation">
        <div
          className={`h-full rounded-full transition-[width] ${over ? "bg-danger" : "bg-call"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {over && (
        <p className="mt-2 text-sm text-danger">הדקות של החודש נוצלו. הבוט ממשיך לענות, והחריגה מחויבת לפי החבילה.</p>
      )}
    </section>
  );
}
