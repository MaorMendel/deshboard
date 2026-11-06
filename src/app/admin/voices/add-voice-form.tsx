"use client";

// טופס הוספת קול. רכיב של דפדפן רק בגלל שרשימת המודלים וטווח המהירות תלויים בספק שנבחר.
// הבחירה כאן רק ממלאת את הקטלוג. הלקוח עצמו לעולם לא שולח ספק, מודל או ID, רק את ה-slug של הקול.

import { useState } from "react";
import { PROVIDERS, type VoiceProvider } from "@/lib/voice-providers";
import type { ActionResult } from "../actions";
import { ActionForm, Field, inputCls } from "../forms";

export function AddVoiceForm({
  action,
  sampleKeys,
}: {
  action: (prev: ActionResult, form: FormData) => Promise<ActionResult>;
  /** לאילו ספקים יש מפתח בשרת ליצירת דוגמה אוטומטית */
  sampleKeys: Record<VoiceProvider, boolean>;
}) {
  const [provider, setProvider] = useState<VoiceProvider>("11labs");
  const spec = PROVIDERS[provider];

  return (
    <ActionForm action={action} submitLabel="להוסיף את הקול">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="ספק">
          <select
            name="provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as VoiceProvider)}
            className={inputCls}
          >
            {(Object.keys(PROVIDERS) as VoiceProvider[]).map((p) => (
              <option key={p} value={p}>
                {PROVIDERS[p].label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Voice ID"
          hint={provider === "11labs" ? "ב-ElevenLabs: Voices -> הקול -> Copy voice ID" : "ב-Cartesia: הקול -> Copy ID"}
        >
          <input name="providerVoiceId" required className={inputCls} dir="ltr" autoComplete="off" />
        </Field>
        <Field label="השם שהלקוחות יראו">
          <input name="name" required maxLength={40} className={inputCls} placeholder="נועם" />
        </Field>
        <Field label="מגדר">
          <select name="gender" required defaultValue="" className={inputCls}>
            <option value="" disabled>
              לבחור...
            </option>
            <option value="female">אישה</option>
            <option value="male">גבר</option>
          </select>
        </Field>
        <Field label="תיאור קצר" hint="מופיע ליד השם אצל הלקוח">
          <input name="description" maxLength={120} className={inputCls} placeholder="חם ובטוח" />
        </Field>
        <Field label="רמה">
          <select name="tier" defaultValue="standard" className={inputCls}>
            <option value="standard">רגיל</option>
            <option value="premium">פרימיום</option>
          </select>
        </Field>
        <Field label="מודל" hint={spec.modelHint}>
          {/* key: בהחלפת ספק הבחירה חוזרת לברירת המחדל של הספק החדש */}
          <select key={provider} name="model" defaultValue={spec.defaultModel} className={inputCls} dir="ltr">
            {spec.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <Field label="מהירות" hint={`לא חובה. ${spec.speed[0]} עד ${spec.speed[1]}, ריק = ברירת המחדל`}>
          <input
            key={provider}
            name="speed"
            type="number"
            step="0.05"
            min={spec.speed[0]}
            max={spec.speed[1]}
            className={inputCls}
            dir="ltr"
          />
        </Field>
        {spec.stability && (
          <Field label="Stability" hint="לא חובה. 0 עד 1, ריק = ברירת המחדל">
            <input name="stability" type="number" step="0.05" min={0} max={1} className={inputCls} dir="ltr" />
          </Field>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="isActive" className="size-4 accent-[var(--color-call)]" />
        להציג ללקוחות מיד
      </label>
      <p className="text-xs text-ink-soft">
        {sampleKeys[provider]
          ? "אחרי ההוספה נוצרת דוגמת שמע אוטומטית. אם היא לא נוצרת, כנראה שה-ID או המודל לא נכונים."
          : `אין מפתח ${provider === "11labs" ? "ELEVENLABS_API_KEY" : "CARTESIA_API_KEY"} בשרת, אז דוגמה לא תיווצר אוטומטית. אפשר להעלות MP3 אחרי ההוספה.`}{" "}
        {provider === "11labs" &&
          "כדי שהקול יעבוד בשיחות, ElevenLabs צריך להיות מחובר ב-Vapi (Integrations) והקול צריך להיות זמין בחשבון שמחובר."}
      </p>
    </ActionForm>
  );
}
