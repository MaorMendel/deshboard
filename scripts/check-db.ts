// npm run db:check
// מריץ את המיגרציות וה-seed על Postgres בזיכרון (PGlite) ובודק שהאילוצים והחישובים עובדים.
// לא צריך Postgres מותקן ולא DATABASE_URL.

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "../src/db";
import { hashAccessKey } from "../src/db/access-keys";
import { getUsage, getUsageByExternalCustomerId } from "../src/db/queries/usage";
import * as schema from "../src/db/schema";
import { seed } from "../src/db/seed";

const { accessLinks, calls, tenants, voices } = schema;

/** מצפה שהפעולה תיכשל על אילוץ מסוים ב-DB */
async function expectConstraint(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    const text = JSON.stringify(err, Object.getOwnPropertyNames(err ?? {})) + String((err as Error)?.cause ?? "");
    assert.ok(text.includes(name), `ציפיתי לשגיאה על ${name}, קיבלתי: ${text.slice(0, 300)}`);
    return;
  }
  assert.fail(`ציפיתי שהאילוץ ${name} יחסום, אבל הפעולה עברה`);
}

async function main() {
  const client = new PGlite();
  const pglite = drizzle(client, { schema });
  await migrate(pglite, { migrationsFolder: "./drizzle" });
  const db = pglite as unknown as Db;
  console.log("✓ המיגרציה רצה");

  const { customerKey, demoKey } = await seed(db);
  assert.equal((await db.select().from(voices)).length, 6);
  console.log("✓ ה-seed רץ: 6 קולות, לקוח ודמו");

  // הקישור מוביל ללקוח הנכון, וה-DB שומר רק hash
  const [link] = await db
    .select({ tenantId: accessLinks.tenantId, name: tenants.name, type: tenants.type, hash: accessLinks.tokenHash })
    .from(accessLinks)
    .innerJoin(tenants, eq(accessLinks.tenantId, tenants.id))
    .where(eq(accessLinks.tokenHash, hashAccessKey(customerKey)));
  assert.equal(link.name, "מספרת רוני");
  assert.notEqual(link.hash, customerKey);
  assert.equal(customerKey.length, 43);
  const [demoLink] = await db
    .select({ type: tenants.type })
    .from(accessLinks)
    .innerJoin(tenants, eq(accessLinks.tenantId, tenants.id))
    .where(eq(accessLinks.tokenHash, hashAccessKey(demoKey)));
  assert.equal(demoLink.type, "demo");
  console.log("✓ מפתח הקישור מוביל ללקוח הנכון, וב-DB נשמר רק ה-hash");

  const customerId = link.tenantId;

  // אילוצים
  await expectConstraint("tenants_demo_fields", () =>
    db.insert(tenants).values({ name: "דמו בלי מגבלה", type: "demo" }),
  );
  await expectConstraint("tenants_verified_phone_e164", () =>
    db.insert(tenants).values({ name: "מספר לא תקין", verifiedPhone: "050-1234567" }),
  );
  await expectConstraint("tenants_external_customer_id_unique", () =>
    db.insert(tenants).values({ name: "כפילות", externalCustomerId: "DEMO-CUST-1001" }),
  );
  console.log("✓ אילוצי tenants חוסמים דמו בלי מגבלה, טלפון לא בפורמט E.164 ומזהה לקוח כפול");

  await db.insert(calls).values({ tenantId: customerId, type: "test", status: "queued" });
  await expectConstraint("calls_one_active_test", () =>
    db.insert(calls).values({ tenantId: customerId, type: "test", status: "in_progress" }),
  );
  console.log("✓ אי אפשר לפתוח שתי שיחות ניסיון במקביל לאותו לקוח");

  await expectConstraint("calls_tenant_id_tenants_id_fk", () =>
    db.delete(tenants).where(eq(tenants.id, customerId)),
  );
  console.log("✓ אי אפשר למחוק לקוח שיש לו שיחות");

  // חישוב השימוש שהמערכת הראשית תמשוך
  const from = new Date("2026-09-30T21:00:00Z"); // 1 באוקטובר, חצות שעון ישראל
  const to = new Date("2026-10-31T22:00:00Z"); // 1 בנובמבר, חצות שעון ישראל

  const startedAt = new Date("2026-10-10T09:00:00Z");
  await db.update(calls).set({ status: "ended", durationSeconds: 61, startedAt, costUsd: "0.1200" }); // ניסיון: 2 דקות מעוגל
  await db.insert(calls).values([
    { tenantId: customerId, type: "inbound", status: "ended", durationSeconds: 120, startedAt, costUsd: "0.2000" },
    { tenantId: customerId, type: "inbound", status: "ended", durationSeconds: 30, startedAt, costUsd: "0.0500" },
    // לא נספרות: שיחה שנכשלה, ושיחה מחוץ לטווח
    { tenantId: customerId, type: "inbound", status: "failed", durationSeconds: 999, startedAt },
    { tenantId: customerId, type: "inbound", status: "ended", durationSeconds: 999, startedAt: new Date("2026-09-30T20:59:00Z") },
  ]);

  const usage = await getUsage(db, customerId, from, to);
  assert.equal(usage.realSeconds, 150);
  assert.equal(usage.testSeconds, 61);
  assert.equal(usage.totalSeconds, 211);
  assert.equal(usage.totalMinutesRoundedPerCall, 5); // 2 + 2 + 1
  assert.equal(usage.callCount, 3);
  assert.equal(usage.vapiCostUsd, 0.37);

  const byExternal = await getUsageByExternalCustomerId(db, "DEMO-CUST-1001", from, to);
  assert.equal(byExternal?.totalSeconds, 211);
  assert.equal(await getUsageByExternalCustomerId(db, "NO-SUCH-CUSTOMER", from, to), null);

  const [demo] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.type, "demo"));
  const empty = await getUsage(db, demo.id, from, to);
  assert.equal(empty.totalSeconds, 0);
  assert.equal(empty.callCount, 0);
  console.log("✓ חישוב השימוש נכון: שיחות אמיתיות + ניסיון, רק שיחות שהסתיימו, רק בטווח, גם לפי מזהה חיצוני");

  console.log("\nהכול עבר.");
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
