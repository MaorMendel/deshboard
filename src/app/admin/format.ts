// עיצוב תאריכים ומספרים לפאנל הניהול

const HE_DATE: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Jerusalem" };

export function fmtDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("he-IL", HE_DATE);
}

export function fmtDateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("he-IL", { ...HE_DATE, hour: "2-digit", minute: "2-digit" });
}

/** "YYYY-MM-DD" ל-input type=date */
export function dateInputValue(value: Date | null | undefined): string {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}

/** "לפני 3 דק׳", "לפני שעתיים", או תאריך אם זה ישן */
export function fmtAgo(value: Date | string | null | undefined, now = new Date()): string {
  if (!value) return "עוד לא";
  const minutes = Math.round((now.getTime() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return "עכשיו";
  if (minutes < 60) return `לפני ${minutes} דק׳`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "לפני שעה" : `לפני ${hours} שעות`;
  return fmtDateTime(value);
}

export function fmtSeconds(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")} דק׳` : `${s} שנ׳`;
}

/** דולרים: $12.34. סכום קטן מסנט אבל לא אפס: "פחות מסנט". */
export function fmtUsd(value: number | string | null | undefined): string {
  if (value == null) return "—";
  const n = Number(value);
  if (n > 0 && n < 0.005) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** אותו דבר עם שלוש ספרות, לעלות לדקה (למשל $0.135) */
export function fmtUsdRate(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`;
}
