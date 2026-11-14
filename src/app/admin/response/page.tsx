import { redirect } from "next/navigation";
import { Suspense } from "react";
import { isAdmin } from "@/server/admin-auth";
import { globalPresets } from "@/server/conversation-style";
import { saveGlobalPresetsAction } from "../actions";
import { ActionForm } from "../forms";
import { TimingTable } from "./timing-table";

export default function Page() {
  return (
    <Suspense fallback={<p className="text-ink-soft">טוען...</p>}>
      <ResponsePresets />
    </Suspense>
  );
}

async function ResponsePresets() {
  if (!(await isAdmin())) redirect("/admin/login");
  const presets = await globalPresets();

  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">קצב מענה</h1>
        <p className="mt-1 text-sm text-ink-soft">
          מה זה &quot;מענה מהיר&quot; ו&quot;מענה סבלני&quot; שהלקוח בוחר בדף שלו. הערכים כאן חלים על כל הלקוחות. ללקוח
          מסוים אפשר לקבוע ערכים משלו, בעמוד שלו.
        </p>
      </div>

      <section className="rounded-xl border border-line bg-surface p-5">
        <ActionForm
          action={saveGlobalPresetsAction}
          submitLabel="לשמור ולעדכן את הלקוחות"
          confirmText="לשמור, ולעדכן עכשיו ב-Vapi את כל הלקוחות שבחרו קצב (חוץ ממי שיש לו ערכים משלו)?"
        >
          <TimingTable values={presets} />
        </ActionForm>
      </section>

      <section className="rounded-xl bg-paper p-5 text-sm text-ink-soft">
        <h2 className="mb-2 font-semibold text-ink">איך זה מגיע ל-Vapi</h2>
        <ul className="list-disc space-y-1.5 pr-5">
          <li>
            Wait, Punctuation, No Punctuation ו-Number נכנסים ל-<code dir="ltr">startSpeakingPlan</code> של ה-assistant.
            Smart Endpointing נכבה, כי כשהוא פעיל Vapi מתעלם משלושת ערכי ה-Punctuation.
          </li>
          <li>
            End-of-Turn נכתב לשדה של ספק התמלול: Deepgram (<code dir="ltr">endpointing</code>, עד 0.5 שניות), Azure,
            Gladia, ElevenLabs (מ-0.3 שניות), AssemblyAI ו-Soniox (מ-0.5 שניות). ל-Google ול-OpenAI אין שדה כזה.
          </li>
          <li>לקוח שעוד לא בחר קצב לא משתנה. שמירה כאן מעדכנת רק לקוחות שכבר בחרו.</li>
          <li>בשיחות ניסיון ובדמואים הערכים חלים מיד, בלי צורך לעדכן.</li>
        </ul>
      </section>
    </main>
  );
}
