import { redirect } from "next/navigation";
import { Suspense } from "react";
import { isAdmin } from "@/server/admin-auth";
import { createCustomerAction } from "../actions";
import { ActionForm, Field, inputCls } from "../forms";
import { AssistantSelect, PhoneNumberSelect, RefreshVapiLink, vapiOptions } from "../vapi-options";

export default function Page({ searchParams }: PageProps<"/admin/new-customer">) {
  return (
    <Suspense fallback={<p className="text-ink-soft">טוען...</p>}>
      <NewCustomer searchParams={searchParams} />
    </Suspense>
  );
}

async function NewCustomer({ searchParams }: { searchParams: PageProps<"/admin/new-customer">["searchParams"] }) {
  if (!(await isAdmin())) redirect("/admin/login");
  const { fresh } = await searchParams;
  const options = await vapiOptions({ fresh: fresh === "1" });

  return (
    <main className="mx-auto w-full max-w-xl">
      <h1 className="mb-2 text-2xl font-semibold">לקוח חדש</h1>
      <p className="mb-6 text-ink-soft">
        מחבר לקוח שכבר יש לו assistant ב-Vapi. ההגדרות הנוכחיות שלו (קול, פתיח, סגירה) נשמרות כגרסה הראשונה.
      </p>

      {!options.configured ? (
        <p className="rounded-xl bg-danger-soft p-4 text-danger">VAPI_PRIVATE_KEY לא מוגדר בשרת, אי אפשר לחבר לקוח.</p>
      ) : (
        <ActionForm action={createCustomerAction} submitLabel="ליצור את הלקוח">
          <Field label="שם העסק">
            <input name="name" required className={inputCls} placeholder="מספרת רוני" />
          </Field>
          <Field label="מזהה במערכת הראשית" hint="לפיו המערכת שלך מבקשת את הדקות (external id)">
            <input name="externalId" required className={inputCls} dir="ltr" placeholder="1001" />
          </Field>
          <div>
            <Field label="ה-assistant של הלקוח ב-Vapi" hint="assistant שכבר מחובר ללקוח מופיע אפור">
              <AssistantSelect options={options} name="assistantId" required />
            </Field>
            <RefreshVapiLink path="/admin/new-customer" />
          </div>
          <Field label="המספר שהבוט עונה בו" hint="שיחות ניסיון יוצאות ממנו">
            <PhoneNumberSelect options={options} name="phoneNumberId" />
          </Field>
          <Field label="המספר לתצוגה" hint="כפי שהלקוח מכיר אותו, מופיע בראש הדף שלו">
            <input name="botPhone" className={inputCls} dir="ltr" placeholder="04-555-0182" />
          </Field>
          <Field label="הטלפון של בעל העסק" hint="שיחות ניסיון מגיעות רק אליו. בלעדיו אין שיחות ניסיון.">
            <input name="testPhone" className={inputCls} dir="ltr" placeholder="0501234567" />
          </Field>

          <fieldset className="mt-2 rounded-xl border border-line p-4">
            <legend className="px-1 text-sm font-medium">החבילה</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="תחילת החבילה" hint="המונה מתאפס כל חודש ביום הזה">
                <input name="planStartedAt" type="date" className={inputCls} dir="ltr" />
              </Field>
              <Field label="דקות בחודש">
                <input name="planMinutes" type="number" min={1} className={inputCls} dir="ltr" placeholder="100" />
              </Field>
            </div>
            <p className="mt-2 text-xs text-ink-soft">לא חובה. אפשר להגדיר או לשנות גם אחר כך, מעמוד הלקוח.</p>
          </fieldset>
        </ActionForm>
      )}
    </main>
  );
}
