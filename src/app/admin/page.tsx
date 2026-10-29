import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { isAdmin } from "@/server/admin-auth";
import { listTenantsOverview, type TenantOverview } from "@/server/admin-service";
import { fmtDate, fmtSeconds } from "./format";
import { btnCls, btnSubtleCls } from "./forms";

export default function Page() {
  return (
    <Suspense fallback={<p className="text-ink-soft">טוען...</p>}>
      <Home />
    </Suspense>
  );
}

function usageCell({ tenant, usage, demoUsedSeconds }: TenantOverview) {
  if (tenant.type === "demo") {
    const limit = tenant.demoSecondsLimit ?? 0;
    return (
      <span>
        {fmtSeconds(demoUsedSeconds ?? 0)} מתוך {fmtSeconds(limit)}, עד {fmtDate(tenant.demoExpiresAt)}
      </span>
    );
  }
  if (!usage) return <span className="text-ink-soft">לא הוגדרה חבילה</span>;
  const over = usage.usedMinutes >= usage.limitMinutes;
  return (
    <span className={over ? "font-medium text-danger" : undefined}>
      {usage.usedMinutes} מתוך {usage.limitMinutes} דק׳ החודש
    </span>
  );
}

async function Home() {
  if (!(await isAdmin())) redirect("/admin/login");
  const rows = await listTenantsOverview();

  return (
    <main>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">לקוחות ודמואים</h1>
        <div className="flex gap-2">
          <Link href="/admin/new-customer" className={btnCls}>
            לקוח חדש
          </Link>
          <Link href="/admin/new-demo" className={btnSubtleCls}>
            דמו חדש
          </Link>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong p-6 text-ink-soft">
          עוד אין לקוחות. אפשר להתחיל מ&quot;לקוח חדש&quot; או מ&quot;דמו חדש&quot;.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-line text-right text-ink-soft">
                <th className="px-4 py-3 font-medium">שם</th>
                <th className="px-4 py-3 font-medium">סוג</th>
                <th className="px-4 py-3 font-medium">מצב</th>
                <th className="px-4 py-3 font-medium">ניצול</th>
                <th className="px-4 py-3 font-medium">קישורים</th>
                <th className="px-4 py-3 font-medium">נוצר</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.tenant.id} className="border-b border-line last:border-0 hover:bg-paper">
                  <td className="px-4 py-3">
                    <Link href={`/admin/t/${row.tenant.id}`} className="font-medium text-call-strong hover:underline">
                      {row.tenant.name}
                    </Link>
                    {row.tenant.externalCustomerId && (
                      <span className="mr-2 text-xs text-ink-soft">#{row.tenant.externalCustomerId}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">{row.tenant.type === "demo" ? "דמו" : "לקוח"}</td>
                  <td className="px-4 py-3">
                    {row.tenant.status === "suspended" ? (
                      <span className="rounded-full bg-danger-soft px-2 py-0.5 text-xs text-danger">מושהה</span>
                    ) : (
                      <span className="rounded-full bg-call-soft px-2 py-0.5 text-xs text-call-strong">פעיל</span>
                    )}
                  </td>
                  <td className="px-4 py-3">{usageCell(row)}</td>
                  <td className="px-4 py-3">{row.activeLinks}</td>
                  <td className="px-4 py-3 text-ink-soft">{fmtDate(row.tenant.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
