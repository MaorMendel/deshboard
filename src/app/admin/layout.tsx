import type { Metadata } from "next";
import Link from "next/link";
import { logoutAction } from "./actions";

export const metadata: Metadata = {
  title: "ניהול הבוטים",
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4 pb-16 pt-8 sm:px-6">
      <header className="mb-8 flex items-center justify-between border-b border-line pb-4">
        <Link href="/admin" className="text-xl font-semibold hover:text-call-strong">
          ניהול הבוטים
        </Link>
        <form action={logoutAction}>
          <button type="submit" className="text-sm text-ink-soft hover:text-ink">
            יציאה
          </button>
        </form>
      </header>
      {children}
    </div>
  );
}
