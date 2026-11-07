"use client";

// גרסאות קודמות של הבוט, בדף של הלקוח. "לחזור לגרסה הזו" מחזיר את ההגדרות למסך בלבד:
// הבוט משתנה רק אחרי "עדכן את הבוט", כך שאפשר קודם לראות, לנסות בשיחת ניסיון, או להתחרט.

import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import type { BotApi } from "@/lib/api";
import type { CustomerVersion } from "@/lib/types";
import { cn } from "./cn";

const WHEN = new Intl.DateTimeFormat("he-IL", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Jerusalem",
});

const FIRST_SHOWN = 5;

type State = { status: "loading" } | { status: "error" } | { status: "ok"; versions: CustomerVersion[] };

function author(v: CustomerVersion): string {
  if (v.restoredFrom) return `חזרה לגרסה ${v.restoredFrom}`;
  return v.by === "you" ? "עדכנת" : "עדכון שלנו";
}

export function VersionsPanel({
  api,
  reloadKey,
  dirty,
  onRestore,
  onDiscard,
}: {
  api: BotApi;
  /** משתנה אחרי כל עדכון, כדי לטעון את הרשימה מחדש */
  reloadKey: number;
  /** יש על המסך שינויים שעוד לא עודכנו */
  dirty: boolean;
  onRestore: (version: CustomerVersion) => void;
  onDiscard: () => void;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [showAll, setShowAll] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .versions()
      .then((res) => !cancelled && setState({ status: "ok", versions: res.versions }))
      .catch(() => !cancelled && setState({ status: "error" }));
    return () => {
      cancelled = true;
    };
  }, [api, reloadKey]);

  if (state.status === "loading") return <p className="text-sm text-ink-soft">טוען את הגרסאות...</p>;
  if (state.status === "error") {
    return <p className="text-sm text-ink-soft">לא הצלחנו לטעון את הגרסאות הקודמות. אפשר לרענן את הדף.</p>;
  }

  const { versions } = state;
  if (versions.length <= 1) {
    return (
      <p className="rounded-2xl border border-line bg-surface px-4 py-3 text-sm text-ink-soft">
        עוד אין גרסאות קודמות. כל לחיצה על &quot;עדכן את הבוט&quot; נשמרת כאן, ואפשר יהיה לחזור אליה.
      </p>
    );
  }
  const shown = showAll ? versions : versions.slice(0, FIRST_SHOWN);

  return (
    <div>
      {dirty && (
        <p className="mb-3 rounded-xl bg-pending-soft px-4 py-2.5 text-sm text-pending">
          יש על המסך שינויים שעוד לא עודכנו בבוט.{" "}
          <button type="button" onClick={onDiscard} className="font-medium underline underline-offset-2">
            לחזור למה שהבוט עובד איתו עכשיו
          </button>
        </p>
      )}

      <ol className="divide-y divide-line rounded-2xl border border-line bg-surface">
        {shown.map((v) => {
          const open = openId === v.id;
          return (
            <li key={v.id} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">גרסה {v.version}</span>
                    {v.current && (
                      <span className="rounded-full bg-call-soft px-2 text-xs leading-6 text-call-strong">
                        הבוט עובד איתה עכשיו
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-ink-soft">
                    {WHEN.format(new Date(v.createdAt))} · {author(v)}
                  </p>
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {v.changes.map((c) => (
                      <li key={c} className="rounded-md bg-paper px-2 py-0.5 text-xs text-ink-soft">
                        {c}
                      </li>
                    ))}
                  </ul>
                </div>
                {!v.current && (
                  <button
                    type="button"
                    onClick={() => onRestore(v)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line-strong px-3 py-1.5 text-sm font-medium text-ink hover:border-call hover:text-call-strong"
                  >
                    <RotateCcw className="size-4" aria-hidden />
                    לחזור לגרסה הזו
                  </button>
                )}
              </div>

              <button
                type="button"
                onClick={() => setOpenId(open ? null : v.id)}
                aria-expanded={open}
                className="mt-2 text-sm text-call hover:text-call-strong hover:underline"
              >
                {open ? "להסתיר" : "מה היה בגרסה הזו"}
              </button>
              {open && <VersionDetails version={v} />}
            </li>
          );
        })}
      </ol>

      {versions.length > FIRST_SHOWN && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          className="mt-3 text-sm font-medium text-call hover:text-call-strong hover:underline"
        >
          {showAll ? "להציג פחות" : `להציג עוד ${versions.length - FIRST_SHOWN} גרסאות`}
        </button>
      )}
    </div>
  );
}

function VersionDetails({ version: v }: { version: CustomerVersion }) {
  const s = v.settings;
  const rows: [string, React.ReactNode][] = [
    ["קול", v.voiceName],
    ["מי מדבר ראשון", s.firstSpeaker === "bot" ? "הבוט" : "המתקשר"],
    ["פתיח", s.openingMessage || "—"],
    ["סגירה", s.closingMessage || "—"],
    [
      "הנחיות",
      s.prompt ? (
        <div dir="auto" className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface px-3 py-2">
          {s.prompt}
        </div>
      ) : (
        <span className="text-ink-soft">לא נשמרו בגרסה הזו (חזרה אליה לא משנה את ההנחיות)</span>
      ),
    ],
  ];
  return (
    <dl className={cn("mt-2 grid gap-x-4 gap-y-2 rounded-xl bg-paper p-3 text-sm sm:grid-cols-[auto_1fr]")}>
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-ink-soft">{label}</dt>
          <dd className="min-w-0 whitespace-pre-wrap">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
