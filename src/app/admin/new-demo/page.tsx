import { redirect } from "next/navigation";
import { Suspense } from "react";
import { isAdmin } from "@/server/admin-auth";
import { createDemoAction } from "../actions";
import { ActionForm, Field, inputCls } from "../forms";

export default function Page() {
  return (
    <Suspense fallback={<p className="text-ink-soft">טוען...</p>}>
      <NewDemo />
    </Suspense>
  );
}

async function NewDemo() {
  if (!(await isAdmin())) redirect("/admin/login");

  return (
    <main className="mx-auto w-full max-w-xl">
      <h1 className="mb-2 text-2xl font-semibold">דמו חדש</h1>
      <p className="mb-6 text-ink-soft">
        ליד שמשחק עם הבוט. השיחות רצות על ה-assistant המשותף, עם מגבלת דקות ותאריך תפוגה. כשהוא הופך ללקוח, מה
        שהגדיר עובר ל-assistant שלו.
      </p>

      <ActionForm action={createDemoAction} submitLabel="ליצור את הדמו">
        <Field label="שם העסק">
          <input name="name" required className={inputCls} placeholder="קליניקת שקד" />
        </Field>
        <Field label="הטלפון של בעל העסק" hint="שיחות הניסיון של הדמו מגיעות רק אליו">
          <input name="testPhone" className={inputCls} dir="ltr" placeholder="0521234567" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="דקות ניסיון">
            <input name="minutes" type="number" min={1} defaultValue={5} className={inputCls} dir="ltr" />
          </Field>
          <Field label="תוקף בימים">
            <input name="days" type="number" min={1} defaultValue={7} className={inputCls} dir="ltr" />
          </Field>
        </div>
      </ActionForm>
    </main>
  );
}
