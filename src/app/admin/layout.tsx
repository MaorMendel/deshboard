import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { isAdmin } from "@/server/admin-auth";
import { pendingMigrations } from "@/server/db-health";
import { logoutAction } from "./actions";

export const metadata: Metadata = {
  title: "ניהול הבוטים",
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4 pb-16 pt-8 sm:px-6">
      <header className="mb-8 flex items-center justify-between border-b border-line pb-4">
        <nav className="flex items-center gap-5">
          <Link href="/admin" className="text-xl font-semibold hover:text-call-strong">
            ניהול הבוטים
          </Link>
          <Link href="/admin" className="text-sm text-ink-soft hover:text-ink">
            לקוחות
          </Link>
          <Link href="/admin/voices" className="text-sm text-ink-soft hover:text-ink">
            קולות
          </Link>
        </nav>
        <form action={logoutAction}>
          <button type="submit" className="text-sm text-ink-soft hover:text-ink">
            יציאה
          </button>
        </form>
      </header>
      <Suspense fallback={null}>
        <MigrationBanner />
      </Suspense>
      {children}
    </div>
  );
}

/** מופיע רק כשיש מיגרציות בקוד שעוד לא הורצו על ה-DB */
async function MigrationBanner() {
  if (!(await isAdmin())) return null;
  const pending = await pendingMigrations();
  if (!pending) return null;
  return (
    <div role="alert" className="mb-6 rounded-xl border border-pending bg-pending-soft px-4 py-3 text-sm text-pending">
      <strong>צריך לעדכן את מבנה ה-DB.</strong> בגרסה הזו יש {pending === 1 ? "מיגרציה אחת" : `${pending} מיגרציות`} שעוד לא
      הורצו. מתיקיית הפרויקט, עם ה-.env של Supabase: <code dir="ltr">npm run db:migrate</code>. עד אז חלק מהדברים לא
      יעבדו או לא יתעדכנו.
    </div>
  );
}
