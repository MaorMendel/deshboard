import type { Metadata } from "next";
import { Suspense } from "react";
import { BotEditor } from "@/components/bot-editor/BotEditor";
import { EditorSkeleton } from "@/components/bot-editor/EditorSkeleton";
import { LinkProblem } from "@/components/bot-editor/LinkProblem";
import { findAccess } from "@/server/access";
import { getBotPageData } from "@/server/bot-service";

export const metadata: Metadata = {
  title: "הבוט שלי",
  robots: { index: false, follow: false },
};

export default function Page({ params }: PageProps<"/b/[key]">) {
  return (
    <Suspense fallback={<EditorSkeleton />}>
      <EditorLoader params={params} />
    </Suspense>
  );
}

// קורא מה-DB לפי המפתח שב-URL, ולכן רץ בזמן הבקשה בתוך Suspense
async function EditorLoader({ params }: { params: PageProps<"/b/[key]">["params"] }) {
  const { key } = await params;
  const access = await findAccess(key);

  switch (access.state) {
    case "invalid":
      return (
        <LinkProblem title="הקישור לא תקין" body="ייתכן שהקישור בוטל או שהוחלף בקישור חדש. כדאי לפנות אלינו כדי לקבל קישור עדכני." />
      );
    case "suspended":
      return <LinkProblem title={access.tenantName} body="החשבון מושהה כרגע. כדאי לפנות אלינו כדי לחדש אותו." />;
    case "demo_expired":
      return (
        <LinkProblem
          title={access.tenantName}
          body="תקופת הדמו הסתיימה. רוצים שהבוט יענה ללקוחות שלכם באמת? דברו איתנו, וכל מה שהגדרתם בדמו יעבור איתכם."
        />
      );
  }

  const data = await getBotPageData(access);
  return <BotEditor accessKey={key} initialData={data} />;
}
