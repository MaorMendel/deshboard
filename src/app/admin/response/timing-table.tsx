// טבלת הזמנים של "מהיר" ו"סבלני": שורה לכל הגדרה, עמודה לכל קצב. משמשת גם את המסך הכללי וגם את עמוד הלקוח.

import type { ResponseStyle } from "@/lib/conversation-style";
import { RESPONSE_STYLES } from "@/lib/conversation-style";
import { DEFAULT_PRESETS, TIMING_FIELDS, type TimingPresets } from "@/server/conversation-style";

const inputCls =
  "w-24 rounded-lg border border-line bg-surface px-2 py-1.5 text-ink tabular-nums focus:border-call disabled:opacity-60";

export function TimingTable({
  values,
  custom,
}: {
  values: TimingPresets;
  /** בעמוד לקוח: לכל קצב תיבת "ערכים משלו". בלי זה (המסך הכללי) כל העמודות נשמרות. */
  custom?: Record<ResponseStyle, boolean>;
}) {
  const styles: ResponseStyle[] = ["fast", "patient"];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead>
          <tr className="border-b border-line text-right align-bottom">
            <th className="py-2 font-medium text-ink-soft">הגדרה (שניות)</th>
            {styles.map((s) => (
              <th key={s} className="py-2 font-medium">
                {RESPONSE_STYLES[s].title}
                {custom && (
                  <label className="mt-1 flex items-center gap-1.5 text-xs font-normal text-ink-soft">
                    <input
                      type="checkbox"
                      name={`${s}.custom`}
                      defaultChecked={custom[s]}
                      className="size-4 accent-[var(--color-call)]"
                    />
                    ערכים משלו ללקוח
                  </label>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TIMING_FIELDS.map((f) => (
            <tr key={f.key} className="border-b border-line last:border-0">
              <td className="py-2 pl-3">
                <span dir="ltr" className="inline-block">
                  {f.label}
                </span>
                <span className="block text-xs text-ink-soft">
                  {f.min}-{f.max} · ברירת מחדל {DEFAULT_PRESETS.fast[f.key]} / {DEFAULT_PRESETS.patient[f.key]}
                </span>
              </td>
              {styles.map((s) => (
                <td key={s} className="py-2">
                  <input
                    name={`${s}.${f.key}`}
                    type="number"
                    step="0.01"
                    min={f.min}
                    max={f.max}
                    required
                    defaultValue={values[s][f.key]}
                    className={inputCls}
                    dir="ltr"
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
