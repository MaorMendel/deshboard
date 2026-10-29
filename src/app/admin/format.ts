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

export function fmtSeconds(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")} דק׳` : `${s} שנ׳`;
}
