// npm run check:e2e
// בדיקה מקצה לקצה של כל הזרימות, מול Postgres בזיכרון ושרת Vapi מדומה.
// לא צריך Postgres, מפתח Vapi או אינטרנט.

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { endCall, startMockVapi } from "./mock-vapi";

const KEY = "test_private_key";
let step = 0;
const ok = (msg: string) => console.log(`✓ ${++step}. ${msg}`);

async function expectError(code: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    assert.equal((err as { code?: string }).code, code, `ציפיתי לשגיאה ${code}, קיבלתי: ${(err as Error).message}`);
    return err as Error;
  }
  assert.fail(`ציפיתי לשגיאה ${code}, אבל הפעולה עברה`);
}

const keyFromUrl = (url: string) => url.split("/b/")[1];

async function main() {
  const mock = await startMockVapi(KEY);
  Object.assign(process.env, {
    VAPI_BASE_URL: mock.url,
    VAPI_PRIVATE_KEY: KEY,
    VAPI_DEMO_ASSISTANT_ID: "asst_demo",
    VAPI_TEST_PHONE_NUMBER_ID: "pn_test",
    APP_URL: "https://bots.example.com",
    INTERNAL_API_SECRET: "a-very-long-internal-secret-123",
    // ElevenLabs מדומה על אותו שרת, ליצירת דוגמאות שמע
    ELEVENLABS_BASE_URL: mock.url,
    ELEVENLABS_API_KEY: KEY,
  });

  const client = new PGlite();
  const pg = drizzle(client, { schema: await import("../src/db/schema") });
  await migrate(pg, { migrationsFolder: "./drizzle" });
  const { setDbForTests } = await import("../src/db");
  setDbForTests(pg as never);

  const schema = await import("../src/db/schema");
  const { importVoicesFromVapi } = await import("../src/server/voice-catalog");
  const admin = await import("../src/server/admin-service");
  const { findAccess } = await import("../src/server/access");
  const { getBotPageData, updateBot, startTestCall } = await import("../src/server/bot-service");
  const { syncTenantCalls } = await import("../src/server/call-sync");
  const { getUsageByExternalCustomerId } = await import("../src/db/queries/usage");
  const { checkInternalAuth } = await import("../src/server/internal-auth");
  const meta = { ip: "203.0.113.7", userAgent: "check-e2e" };

  // ---- assistants קיימים ב-Vapi, עם קולות מכווננים ----
  const noaVoice = { provider: "cartesia", voiceId: "ca_noa", model: "sonic-3.6", generationConfig: { speed: 1.1, volume: 1 }, language: "he" };
  const itaiVoice = { provider: "cartesia", voiceId: "ca_itai", model: "sonic-3.6", generationConfig: { speed: 0.9 } };
  mock.assistants.set("asst_roni", {
    id: "asst_roni",
    name: "מספרת רוני",
    voice: noaVoice,
    firstMessage: "שלום, הגעתם למספרת רוני, איך אפשר לעזור? {{customer.name}}",
    firstMessageMode: "assistant-speaks-first",
    endCallMessage: "יום טוב!",
  });
  mock.assistants.set("asst_dental", { id: "asst_dental", name: "מרפאת שיניים", voice: itaiVoice });
  mock.assistants.set("asst_demo", { id: "asst_demo", name: "Demo base", voice: noaVoice });

  // 1. ייבוא קולות
  const imported = await importVoicesFromVapi();
  assert.equal(imported.voices.length, 2);
  assert.ok(imported.voices.every((v) => v.isNew));
  const db = pg as unknown as import("../src/db").Db;
  const voiceRows = await db.select().from(schema.voices);
  assert.ok(voiceRows.every((v) => !v.isActive), "קולות מיובאים נכנסים כבויים");
  assert.deepEqual(voiceRows.find((v) => v.providerVoiceId === "ca_noa")!.providerConfig, noaVoice);
  await db.update(schema.voices).set({ isActive: true, name: "איתי", gender: "male" }).where(eq(schema.voices.providerVoiceId, "ca_itai"));
  ok("ייבוא קולות מה-assistants: 2 קולות, כבויים, עם ההגדרות המלאות. הפעלתי אחד.");

  // 1ב. דוגמת שמע: נשמרת ב-DB ומוגשת מה-route, בלי קשר לדיסק או להפעלה מחדש
  const { sampleUrlFor, voiceSample } = await import("../src/server/voice-samples");
  const sampleBytes = Buffer.from("ID3 fake-mp3-for-test");
  const sampleTime = new Date();
  const [sampleVoice] = voiceRows;
  await db
    .update(schema.voices)
    .set({ sampleAudio: sampleBytes, sampleUpdatedAt: sampleTime, sampleUrl: sampleUrlFor(sampleVoice.id, sampleTime) })
    .where(eq(schema.voices.id, sampleVoice.id));
  const served = await voiceSample(sampleVoice.id);
  assert.ok(served, "הדוגמה נקראת מה-DB");
  // PGlite מחזיר Uint8Array ו-postgres-js מחזיר Buffer. משווים את התוכן עצמו.
  assert.deepEqual(Buffer.from(served.audio), sampleBytes);
  assert.match(sampleUrlFor(sampleVoice.id, sampleTime), /^\/api\/voice-samples\/.+\?v=\d+$/);
  assert.equal(await voiceSample("no-such-voice"), null);
  ok("דוגמת שמע נשמרת ב-DB ונקראת ממנו, עם כתובת שכוללת גרסה (לא נתקעת במטמון)");

  // 2. חיבור לקוח קיים
  const roni = await admin.createCustomer({
    name: "מספרת רוני",
    externalCustomerId: "1001",
    vapiAssistantId: "asst_roni",
    vapiPhoneNumberId: "pn_roni",
    botPhoneDisplay: "04-555-0182",
    verifiedPhone: "050-123-4471",
  });
  assert.ok(roni.url.startsWith("https://bots.example.com/b/"));
  const roniKey = keyFromUrl(roni.url);
  assert.equal(roni.tenant.verifiedPhone, "+972501234471");
  ok("חיבור לקוח: הקישור נוצר, הטלפון נשמר בפורמט בינלאומי");

  // 3. הדף שלו מציג את מה שמוגדר היום ב-Vapi
  const access = await findAccess(roniKey);
  assert.equal(access.state, "ok");
  if (access.state !== "ok") return;
  const page = await getBotPageData(access);
  assert.equal(page.settings.openingMessage, "שלום, הגעתם למספרת רוני, איך אפשר לעזור? {{customer.name}}");
  assert.equal(page.settings.closingMessage, "יום טוב!");
  assert.equal(page.settings.firstSpeaker, "bot");
  const noaId = voiceRows.find((v) => v.providerVoiceId === "ca_noa")!.id;
  const itaiId = voiceRows.find((v) => v.providerVoiceId === "ca_itai")!.id;
  assert.equal(page.settings.voiceId, noaId);
  assert.deepEqual(page.voices.map((v) => v.id).sort(), [itaiId, noaId].sort(), "הקול הנוכחי מוצג גם כשהוא כבוי");
  assert.equal(page.testPhoneMasked, "050-•••-4471");
  assert.deepEqual(page.plan, { type: "customer", usage: null }, "בלי חבילה מוגדרת אין מונה דקות");
  ok("הדף של הלקוח מציג את ההגדרות הנוכחיות מ-Vapi, כולל משתנים, והקול הנוכחי שלו");

  // 4. עדכון הבוט: PATCH עם אובייקט voice מלא
  const newSettings = { voiceId: itaiId, firstSpeaker: "caller" as const, openingMessage: "", closingMessage: "תודה ולהתראות" };
  mock.requests.length = 0;
  const upd = await updateBot(roniKey, newSettings, meta);
  const patch = mock.requests.find((r) => r.method === "PATCH");
  assert.ok(patch, "נשלח PATCH ל-Vapi");
  assert.equal(patch.path, "/assistant/asst_roni");
  assert.deepEqual(patch.body, {
    voice: itaiVoice,
    firstMessageMode: "assistant-waits-for-user",
    firstMessage: "",
    endCallMessage: "תודה ולהתראות",
  });
  assert.equal(mock.assistants.get("asst_roni")!.firstMessageMode, "assistant-waits-for-user");
  const versions = await db.select().from(schema.botVersions).where(eq(schema.botVersions.tenantId, roni.tenant.id));
  assert.equal(versions.length, 2);
  const audit = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.tenantId, roni.tenant.id), eq(schema.auditLog.action, "bot.update")));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].ip, "203.0.113.7");
  assert.ok(upd.lastUpdatedAt);
  ok("עדכון הבוט: PATCH ל-assistant הנכון עם הקול המכוונן המלא, גרסה 2 נשמרה, נרשם ב-audit_log");

  // 5. כשל ב-Vapi: שום דבר לא נשמר
  mock.failNext = { method: "PATCH", path: /^\/assistant\//, status: 500 };
  await expectError("vapi_error", () => updateBot(roniKey, { ...newSettings, closingMessage: "שונה" }, meta));
  const versionsAfterFail = await db.select().from(schema.botVersions).where(eq(schema.botVersions.tenantId, roni.tenant.id));
  assert.equal(versionsAfterFail.length, 2);
  ok("כש-Vapi נכשל בעדכון: הלקוח מקבל שגיאה ברורה, ואף גרסה לא נשמרת");

  // 5ב. פתיח וסגירה ריקים: הבוט פותח במשפט שהמודל מחבר מההנחיות
  mock.requests.length = 0;
  await updateBot(roniKey, { ...newSettings, firstSpeaker: "bot", openingMessage: "", closingMessage: "" }, meta);
  const emptyPatch = mock.requests.find((r) => r.method === "PATCH")!.body as Record<string, unknown>;
  assert.equal(emptyPatch.firstMessageMode, "assistant-speaks-first-with-model-generated-message");
  assert.equal(emptyPatch.firstMessage, "");
  assert.equal(emptyPatch.endCallMessage, "");
  // ועם פתיח: המצב הרגיל
  mock.requests.length = 0;
  await updateBot(roniKey, { ...newSettings, firstSpeaker: "bot", openingMessage: "שלום", closingMessage: "" }, meta);
  assert.equal(
    (mock.requests.find((r) => r.method === "PATCH")!.body as Record<string, unknown>).firstMessageMode,
    "assistant-speaks-first",
  );
  // מחזירים את הבוט החי למצב שהבדיקות הבאות מצפות לו
  await updateBot(roniKey, newSettings, meta);
  ok("פתיח ריק מותר: הבוט פותח במשפט שהמודל מחבר. עם פתיח, נשלח assistant-speaks-first");

  // 5ג. פאנל הניהול מציג את הקישור שהונפק
  const detail = await admin.tenantDetail("1001");
  assert.equal(detail.links.length, 1);
  assert.equal(detail.links[0].url, roni.url, "הקישור משוחזר מהעותק המוצפן");
  const [linkRow] = await db.select().from(schema.accessLinks).where(eq(schema.accessLinks.tenantId, roni.tenant.id));
  assert.ok(linkRow.tokenEncrypted && !linkRow.tokenEncrypted.includes(keyFromUrl(roni.url)), "המפתח לא נשמר כטקסט גלוי");
  ok("פאנל הניהול מציג קישור קיים, והמפתח שמור מוצפן ב-DB");

  // 6. שיחת ניסיון (קול כבוי שהוא לא הקול הנוכחי לא זמין לבחירה, אז מפעילים אותו)
  await expectError("validation", () => startTestCall(roniKey, { ...newSettings, voiceId: noaId }, meta));
  await db.update(schema.voices).set({ isActive: true, name: "נועה" }).where(eq(schema.voices.id, noaId));
  mock.requests.length = 0;
  const draft = { ...newSettings, voiceId: noaId, firstSpeaker: "bot" as const, openingMessage: "טיוטה" };
  const tc = await startTestCall(roniKey, draft, meta);
  const post = mock.requests.find((r) => r.method === "POST" && r.path === "/call")!;
  assert.deepEqual(post.body, {
    assistantId: "asst_roni",
    assistantOverrides: { voice: noaVoice, firstMessageMode: "assistant-speaks-first", firstMessage: "טיוטה", endCallMessage: "תודה ולהתראות" },
    phoneNumberId: "pn_roni",
    customer: { number: "+972501234471" },
    name: "שיחת ניסיון - מספרת רוני",
  });
  assert.equal(tc.demoRemainingSeconds, null);
  assert.equal(mock.assistants.get("asst_roni")!.firstMessage, "", "שיחת ניסיון לא משנה את הבוט החי");
  ok("שיחת ניסיון: יוצאת מהמספר של הלקוח למספר המאומת, עם ההגדרות שעל המסך, בלי לשנות את הבוט החי");

  // 7. שתי שיחות במקביל נחסמות, ואחרי שהראשונה נגמרת אפשר שוב
  await expectError("busy", () => startTestCall(roniKey, draft, meta));
  const [firstTest] = await db.select().from(schema.calls).where(eq(schema.calls.tenantId, roni.tenant.id));
  endCall(mock, firstTest.vapiCallId!, 75, 0.12);
  await startTestCall(roniKey, draft, meta);
  const [refreshed] = await db.select().from(schema.calls).where(eq(schema.calls.id, firstTest.id));
  assert.equal(refreshed.status, "ended");
  assert.equal(refreshed.durationSeconds, 75);
  ok("שיחת ניסיון שנייה במקביל נחסמת. כשהראשונה מסתיימת ב-Vapi, הבאה עוברת והמשך נשמר (75 שניות)");

  // 8. סנכרון שיחות אמיתיות וחישוב דקות
  const now = new Date().toISOString();
  mock.calls.set("call_in_1", { id: "call_in_1", type: "inboundPhoneCall", status: "ended", assistantId: "asst_roni", customer: { number: "+972541112233" }, createdAt: now, updatedAt: now, startedAt: new Date(Date.now() - 200_000).toISOString(), endedAt: new Date(Date.now() - 80_000).toISOString(), cost: 0.3 });
  mock.calls.set("call_in_2", { id: "call_in_2", type: "inboundPhoneCall", status: "in-progress", assistantId: "asst_roni", createdAt: now, updatedAt: now, startedAt: now });
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await syncTenantCalls(roni.tenant, from);
  await syncTenantCalls(roni.tenant, from); // פעמיים: לא יוצרות כפילויות
  const allCalls = await db.select().from(schema.calls).where(eq(schema.calls.tenantId, roni.tenant.id));
  assert.equal(allCalls.filter((c) => c.type === "test").length, 2, "שיחות ניסיון נשארות מסוג test");
  assert.equal(allCalls.filter((c) => c.type === "inbound").length, 2);
  const usage = await getUsageByExternalCustomerId(db, "1001", from, new Date(Date.now() + 60_000));
  assert.ok(usage);
  assert.equal(usage.realSeconds, 120);
  assert.equal(usage.testSeconds, 75);
  assert.equal(usage.totalMinutesRoundedPerCall, 4); // 2 + 2
  ok("סנכרון שיחות מ-Vapi: נכנסות נשמרות, ניסיון נשאר ניסיון, בלי כפילויות. דקות: 120 שניות אמיתיות + 75 ניסיון");

  // 8א. סנכרון מצטבר: מושכים מ-Vapi רק מה שהשתנה מאז הסנכרון הקודם
  const { lastSyncedAt, tenantSyncKey } = await import("../src/server/call-sync");
  const askedSince = () =>
    new URL("http://x" + mock.requests.find((r) => r.path.startsWith("/call?"))!.path).searchParams.get("updatedAtGe")!;
  const syncedBefore = (await lastSyncedAt(tenantSyncKey(roni.tenant.id)))!;
  assert.ok(syncedBefore, "נשמר מתי סונכרן");
  mock.requests.length = 0;
  await syncTenantCalls(roni.tenant, from);
  assert.equal(askedSince(), new Date(syncedBefore.getTime() - 10 * 60_000).toISOString(), "רק מהסנכרון הקודם, עם 10 דקות חפיפה");
  // תקופה מוקדמת ממה שכבר מכוסה: מושכים הכול ממנה
  const olderFrom = new Date(from.getTime() - 7 * 86_400_000);
  mock.requests.length = 0;
  await syncTenantCalls(roni.tenant, olderFrom);
  assert.equal(askedSince(), olderFrom.toISOString());
  mock.requests.length = 0;
  assert.equal((await syncTenantCalls(roni.tenant, from, { minIntervalMs: 60_000 })).skipped, true);
  assert.equal(mock.requests.length, 0, "סונכרן לפני רגע: לא פונים ל-Vapi");
  assert.equal((await db.select().from(schema.calls).where(eq(schema.calls.tenantId, roni.tenant.id))).length, allCalls.length, "בלי כפילויות");
  ok("סנכרון מצטבר: רק מה שהשתנה מאז הפעם הקודמת (עם חפיפה). תקופה מוקדמת יותר נמשכת במלואה. סונכרן לפני רגע: בלי פנייה ל-Vapi");

  // 8ב. חבילה: הגדרה, ניצול במחזור הנוכחי, וולידציה
  await admin.updatePlan("1001", { startedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), minutes: 100 });
  const roniAccessPlan = await findAccess(roniKey);
  assert.equal(roniAccessPlan.state, "ok");
  if (roniAccessPlan.state === "ok") {
    const pageWithPlan = await getBotPageData(roniAccessPlan);
    assert.equal(pageWithPlan.plan.type, "customer");
    if (pageWithPlan.plan.type === "customer") {
      assert.ok(pageWithPlan.plan.usage, "לקוח עם חבילה רואה את הניצול");
      // 120 שניות אמיתיות + 75 ניסיון = 195 שניות = 3 דקות שלמות, בלי עיגול של שיחה בודדת
      assert.equal(pageWithPlan.plan.usage!.usedMinutes, 3);
      assert.equal(pageWithPlan.plan.usage!.limitMinutes, 100);
      assert.ok(new Date(pageWithPlan.plan.usage!.renewsAt) > new Date());
    }
  }
  const overview = await admin.listTenantsOverview();
  const roniRow = overview.find((r) => r.tenant.externalCustomerId === "1001")!;
  assert.equal(roniRow.usage?.usedMinutes, 3, "הפאנל מראה את אותן דקות כמו הלקוח");
  await expectError("validation", () => admin.updatePlan("1001", { startedAt: null, minutes: 50 }));
  await expectError("validation", () => admin.updatePlan("1001", { startedAt: new Date(), minutes: -5 }));
  ok("חבילה: 100 דקות בחודש, 195 שניות שיחה = 3 דקות (בלי עיגול לשיחה). חבילה חלקית או שלילית נדחית");

  // 8ב2. עלות: מה ש-Vapi חייב על השיחות, מפורט לפי רכיב, באותה תקופה כמו הדקות
  const breakdown3 = {
    transport: 0.05,
    stt: 0.06,
    llm: 0.2,
    tts: 0.1,
    vapi: 0.05,
    total: 0.5,
    llmPromptTokens: 1000,
    analysisCostBreakdown: { summary: 0.02, structuredData: 0.01 },
  };
  const nowIso = new Date().toISOString();
  mock.calls.set("call_in_3", { id: "call_in_3", type: "inboundPhoneCall", status: "ended", assistantId: "asst_roni", createdAt: nowIso, updatedAt: nowIso, startedAt: new Date(Date.now() - 100_000).toISOString(), endedAt: new Date(Date.now() - 40_000).toISOString(), cost: 0.5, costBreakdown: breakdown3 });
  // שיחה יוצאת שלא נענתה: אין לה זמן התחלה, אבל יש לה מחיר
  mock.calls.set("call_out_noanswer", { id: "call_out_noanswer", type: "outboundPhoneCall", status: "ended", assistantId: "asst_roni", createdAt: nowIso, updatedAt: nowIso, cost: 0.01, endedReason: "customer-did-not-answer" });
  await syncTenantCalls(roni.tenant, from);
  const [row3] = await db.select().from(schema.calls).where(eq(schema.calls.vapiCallId, "call_in_3"));
  assert.deepEqual(row3.costBreakdown, breakdown3, "הפירוט נשמר כמו ש-Vapi מחזיר אותו");
  // שיחה מהמחזור הקודם (החבילה התחילה לפני 10 ימים): נספרת רק ב"תקופה הקודמת"
  await db.insert(schema.calls).values({ tenantId: roni.tenant.id, vapiCallId: "call_old", type: "inbound", status: "ended", startedAt: new Date(Date.now() - 15 * 86_400_000), createdAt: new Date(Date.now() - 15 * 86_400_000), durationSeconds: 60, costUsd: "1.5000" });

  const roniCalls = await db.select().from(schema.calls).where(eq(schema.calls.tenantId, roni.tenant.id));
  const inCycle = roniCalls.filter((c) => c.vapiCallId !== "call_old" && c.costUsd != null);
  const sum = (rows: typeof roniCalls) => rows.reduce((a, c) => a + Number(c.costUsd), 0);
  const expectedTotal = sum(inCycle);
  const near = (a: number, b: number, msg: string) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);
  const roniDetail = await admin.tenantDetail("1001");
  const c = roniDetail.cost!;
  assert.equal(roniDetail.costPeriod.kind, "cycle");
  near(c.totalUsd, expectedTotal, "סך הכול");
  near(c.llmUsd, 0.2, "מודל");
  near(c.ttsUsd, 0.1, "קול");
  near(c.sttUsd, 0.06, "תמלול");
  near(c.transportUsd, 0.05, "טלפוניה");
  near(c.vapiUsd, 0.05, "Vapi");
  near(c.analysisUsd, 0.03, "ניתוח");
  near(c.otherUsd, expectedTotal - 0.49, "שיחות בלי פירוט נספרות כלא מפורט");
  near(c.testUsd, sum(inCycle.filter((r) => r.type === "test")), "שיחות ניסיון");
  assert.equal(c.pricedCalls, inCycle.length);
  assert.ok(inCycle.some((r) => r.vapiCallId === "call_out_noanswer"), "שיחה שלא נענתה נספרת בעלות");
  near(roniDetail.previousCostUsd!, 1.5, "התקופה הקודמת");
  assert.equal(roniDetail.recentCalls.find((r) => r.costUsd === "0.5000")?.type, "inbound");
  const roniCostRow = (await admin.listTenantsOverview()).find((r) => r.tenant.externalCustomerId === "1001")!;
  near(roniCostRow.costUsd, expectedTotal, "הרשימה מראה את אותו סכום");
  await db.delete(schema.calls).where(eq(schema.calls.vapiCallId, "call_old"));

  // לקוח בלי חבילה: החודש הקלנדרי בשעון ישראל. דמו: מתחילת הדמו.
  const { costPeriod, previousCostPeriod } = await import("../src/server/plan");
  const novNoon = new Date("2026-11-07T09:00:00Z");
  const noPlan = costPeriod({ ...roni.tenant, planStartedAt: null, planMinutes: null }, novNoon);
  assert.equal(noPlan.kind, "month");
  assert.equal(noPlan.from.toISOString(), "2026-10-31T22:00:00.000Z", "1 בנובמבר, חצות בישראל");
  assert.equal(noPlan.to.toISOString(), "2026-11-30T22:00:00.000Z");
  assert.equal(previousCostPeriod(noPlan)!.from.toISOString(), "2026-09-30T21:00:00.000Z", "1 באוקטובר, שעון קיץ");
  ok("עלות: נשמרת מ-Vapi עם פירוט (מודל, קול, תמלול, טלפוניה, Vapi, ניתוח), באותו מחזור כמו הדקות, כולל שיחות שלא נענו. התקופה הקודמת נפרדת");

  // 8ב3. העמוד בפאנל לא מחכה ל-Vapi: מציג את מה שיש, והסנכרון ממשיך ברקע
  const bgIso = new Date().toISOString();
  mock.calls.set("call_in_bg", { id: "call_in_bg", type: "inboundPhoneCall", status: "ended", assistantId: "asst_roni", createdAt: bgIso, updatedAt: bgIso, startedAt: new Date(Date.now() - 50_000).toISOString(), endedAt: bgIso, cost: 0.07 });
  let background: Promise<unknown> | null = null;
  const quick = await admin.tenantDetail("1001", { syncWaitMs: 0, forceSync: true, onBackground: (p) => (background = p) });
  assert.equal(quick.syncPending, true, "לא חיכה לסנכרון");
  assert.ok(background, "הסנכרון הועבר לרקע");
  await background;
  assert.equal((await db.select().from(schema.calls).where(eq(schema.calls.vapiCallId, "call_in_bg"))).length, 1, "והוא הסתיים");
  const waited = await admin.tenantDetail("1001", { syncWaitMs: 5_000, forceSync: true });
  assert.equal(waited.syncPending, false);
  assert.ok(waited.syncedAt && Date.now() - waited.syncedAt.getTime() < 60_000);
  ok("עמוד הלקוח בפאנל: מציג מיד את מה שב-DB, הסנכרון מ-Vapi ממשיך ברקע, ומוצג מתי סונכרן לאחרונה");

  // 8ג. עריכת הפרומפט: רק הודעת ה-system משתנה, שאר ה-model נשמר
  mock.assistants.get("asst_roni")!.model = {
    provider: "openai",
    model: "gpt-4o",
    temperature: 0.7,
    messages: [{ role: "system", content: "פרומפט ישן" }, { role: "assistant", content: "היי" }],
  };
  await admin.updateAssistantPrompt("1001", "פרומפט חדש לבדיקה");
  const patchedModel = mock.assistants.get("asst_roni")!.model! as {
    temperature?: number;
    messages: { role: string; content?: string }[];
  };
  assert.equal(patchedModel.temperature, 0.7, "הטמפרטורה לא נמחקת בעדכון פרומפט");
  assert.equal(patchedModel.messages.find((m) => m.role === "system")!.content, "פרומפט חדש לבדיקה");
  assert.equal(patchedModel.messages.length, 2, "שאר ההודעות נשארות");
  assert.equal((await admin.getAssistantPrompt("1001")).prompt, "פרומפט חדש לבדיקה");
  await expectError("validation", () => admin.updateAssistantPrompt("1001", "   "));
  ok("עריכת פרומפט בפאנל: הודעת ה-system מתעדכנת ב-Vapi, הטמפרטורה ושאר ההודעות לא נפגעות");

  // 8ג2. היסטוריית גרסאות: גם עריכה מהפאנל נשמרת, ואפשר לחזור לכל גרסה
  const versionsMod = await import("../src/server/versions");
  const { describeChanges } = await import("../src/lib/version-diff");
  let hist = await versionsMod.listVersions(await admin.findTenant("1001"));
  const top = hist.versions[0];
  assert.equal(top.current, true);
  assert.equal(top.by, "admin");
  assert.equal(top.settings.prompt, "פרומפט חדש לבדיקה", "עריכת הנחיות מהפאנל יצרה גרסה");
  const voiceName = (id: string) => hist.voiceNames[id] ?? id;
  assert.ok(describeChanges(hist.versions[1].settings, top.settings, voiceName).some((c) => c.startsWith("הנחיות")));
  const v1 = hist.versions.at(-1)!;
  assert.equal(v1.version, 1);
  assert.deepEqual(describeChanges(null, v1.settings, voiceName), ["גרסה ראשונה"]);
  assert.ok(hist.versions.some((v) => v.by === "link"), "שמירות של הלקוח מופיעות");

  mock.requests.length = 0;
  const restored = await versionsMod.restoreVersion(await admin.findTenant("1001"), v1.id);
  assert.equal(restored.restoredFrom, 1);
  assert.equal(restored.version, top.version + 1);
  const restorePatch = mock.requests.find((r) => r.method === "PATCH")!.body as Record<string, unknown>;
  assert.deepEqual(restorePatch.voice, noaVoice, "הקול נבנה מהקטלוג");
  assert.equal(restorePatch.endCallMessage, v1.settings.closingMessage);
  assert.equal(restorePatch.firstMessage, v1.settings.openingMessage);
  assert.equal(restorePatch.model, undefined, "בגרסה 1 אין הנחיות: לא נוגעים בהנחיות הנוכחיות");
  assert.equal(mock.assistants.get("asst_roni")!.endCallMessage, v1.settings.closingMessage);
  hist = await versionsMod.listVersions(await admin.findTenant("1001"));
  assert.equal(hist.versions[0].restoredFrom, 1);
  assert.equal(hist.versions[0].current, true);
  assert.equal(hist.versions[0].settings.prompt, "פרומפט חדש לבדיקה", "הגרסה החדשה שומרת את ההנחיות שנשארו");
  await expectError("validation", async () => versionsMod.restoreVersion(await admin.findTenant("1001"), hist.versions[0].id));
  await expectError("validation", async () =>
    versionsMod.restoreVersion(await admin.findTenant("1001"), "00000000-0000-0000-0000-000000000000"),
  );
  // וחזרה לגרסה שלפני השחזור: גם שחזור אפשר לבטל
  await versionsMod.restoreVersion(await admin.findTenant("1001"), top.id);
  assert.equal(mock.assistants.get("asst_roni")!.endCallMessage, top.settings.closingMessage);
  assert.equal((mock.assistants.get("asst_roni")!.model as { temperature?: number }).temperature, 0.7, "שאר ה-model לא נפגע");
  ok("היסטוריה: כל שמירה (של הלקוח ושל הפאנל) היא גרסה. חזרה לגרסה שולחת ל-Vapi את הקול מהקטלוג, הפתיח והסגירה, שומרת הנחיות כשבגרסה אין, ואפשר לבטל אותה");

  // 10ב. הלקוח עורך את ההנחיות מהדף שלו
  const roniAccessPrompt = await findAccess(roniKey);
  assert.equal(roniAccessPrompt.state, "ok");
  if (roniAccessPrompt.state !== "ok") throw new Error("לא אמור לקרות");
  const pagePrompt = await getBotPageData(roniAccessPrompt);
  assert.equal(pagePrompt.settings.prompt, "פרומפט חדש לבדיקה", "הדף מציג את ההנחיות החיות מ-Vapi");

  const withPrompt = { ...pagePrompt.settings, prompt: "ההנחיות שהלקוח כתב" };
  mock.requests.length = 0;
  await updateBot(roniKey, withPrompt, meta);
  const promptPatch = mock.requests.find((r) => r.method === "PATCH")!.body as {
    model: { temperature?: number; messages: { role: string; content?: string }[] };
  };
  assert.equal(promptPatch.model.messages.find((m) => m.role === "system")!.content, "ההנחיות שהלקוח כתב");
  assert.equal(promptPatch.model.temperature, 0.7, "עדכון מהלקוח לא מוחק את שאר ה-model");
  assert.equal(promptPatch.model.messages.length, 2, "שאר ההודעות נשארות");

  // הנחיות ריקות: לא נוגעים ב-model בכלל
  mock.requests.length = 0;
  await updateBot(roniKey, { ...withPrompt, prompt: "" }, meta);
  const noPromptPatch = mock.requests.find((r) => r.method === "PATCH")!.body as { model?: unknown };
  assert.equal(noPromptPatch.model, undefined, "בלי הנחיות, ה-model לא נשלח ל-Vapi");
  assert.equal(
    (mock.assistants.get("asst_roni")!.model!.messages as { role: string; content?: string }[]).find((m) => m.role === "system")!.content,
    "ההנחיות שהלקוח כתב",
    "ההנחיות שב-Vapi נשארות",
  );

  // שיחת ניסיון עם הנחיות שעוד לא עודכנו: override בלבד, הבוט החי לא משתנה
  const openTests = await db.select().from(schema.calls).where(and(eq(schema.calls.tenantId, roni.tenant.id), eq(schema.calls.type, "test")));
  for (const t of openTests) if (t.vapiCallId && t.status !== "ended") endCall(mock, t.vapiCallId, 5);
  mock.requests.length = 0;
  await startTestCall(roniKey, { ...withPrompt, prompt: "הנחיות לניסיון בלבד" }, meta);
  const testPost = mock.requests.find((r) => r.method === "POST")!.body as {
    assistantOverrides: { model?: { messages: { role: string; content?: string }[] } };
  };
  assert.equal(
    testPost.assistantOverrides.model!.messages.find((m) => m.role === "system")!.content,
    "הנחיות לניסיון בלבד",
  );
  assert.equal(
    (mock.assistants.get("asst_roni")!.model!.messages as { role: string; content?: string }[]).find((m) => m.role === "system")!.content,
    "ההנחיות שהלקוח כתב",
    "שיחת ניסיון לא משנה את ההנחיות של הבוט החי",
  );
  ok("הלקוח עורך הנחיות מהדף שלו: נשלחות ל-Vapi, ריק לא נוגע בקיים, ושיחת ניסיון היא override בלבד");

  // 13ב. מסך שהיה פתוח מזמן לא דורס הנחיות שהשתנו בינתיים
  const loaded = { ...withPrompt, prompt: "ההנחיות שהלקוח כתב" }; // ההגדרות כפי שהמסך טען אותן
  // בינתיים מישהו אחר (אדמין, או עריכה ישירה ב-Vapi) שינה את ההנחיות
  await admin.updateAssistantPrompt("1001", "הנחיות חדשות יותר, שנכתבו אחרי שהמסך נטען");
  // הלקוח משנה רק את הפתיח ולוחץ "עדכן את הבוט". ההנחיות שעל המסך הן עדיין הישנות.
  mock.requests.length = 0;
  await updateBot(roniKey, { ...loaded, openingMessage: "פתיח חדש" }, meta, loaded);
  const stalePatch = mock.requests.find((r) => r.method === "PATCH")!.body as Record<string, unknown>;
  assert.equal(stalePatch.model, undefined, "הנחיות שלא נגעו בהן לא נשלחות ל-Vapi");
  assert.equal(stalePatch.voice, undefined, "קול שלא נגעו בו לא נשלח ל-Vapi");
  assert.equal(stalePatch.endCallMessage, undefined, "סגירה שלא נגעו בה לא נשלחת ל-Vapi");
  assert.equal(stalePatch.firstMessage, "פתיח חדש", "הפתיח כן מתעדכן");
  assert.equal(
    (await admin.getAssistantPrompt("1001")).prompt,
    "הנחיות חדשות יותר, שנכתבו אחרי שהמסך נטען",
    "ההנחיות החדשות שרדו",
  );
  // ואם הלקוח כן ערך את ההנחיות, השינוי שלו נכתב
  mock.requests.length = 0;
  await updateBot(roniKey, { ...loaded, prompt: "מה שהלקוח ערך עכשיו" }, meta, loaded);
  assert.equal(
    (await admin.getAssistantPrompt("1001")).prompt,
    "מה שהלקוח ערך עכשיו",
    "עריכה אמיתית של הלקוח נשמרת",
  );
  ok("מסך שהיה פתוח מזמן לא דורס הנחיות שהשתנו בינתיים, אבל עריכה אמיתית כן נשמרת");

  // 15ב. שינוי שהמפתח עושה ישירות ב-Vapi מופיע אצל הלקוח ברענון
  const live = mock.assistants.get("asst_roni")!;
  live.voice = noaVoice; // הקול הוחלף ב-Vapi
  live.firstMessage = "פתיח שנכתב ישירות ב-Vapi";
  live.firstMessageMode = "assistant-speaks-first";
  live.endCallMessage = "סגירה שנכתבה ישירות ב-Vapi";
  const afterVapiEdit = await findAccess(roniKey);
  assert.equal(afterVapiEdit.state, "ok");
  if (afterVapiEdit.state !== "ok") throw new Error("לא אמור לקרות");
  const pageAfterVapiEdit = await getBotPageData(afterVapiEdit);
  assert.equal(pageAfterVapiEdit.settings.voiceId, noaId, "הקול שהוחלף ב-Vapi מוצג");
  assert.equal(pageAfterVapiEdit.settings.openingMessage, "פתיח שנכתב ישירות ב-Vapi");
  assert.equal(pageAfterVapiEdit.settings.closingMessage, "סגירה שנכתבה ישירות ב-Vapi");
  assert.equal(pageAfterVapiEdit.settings.firstSpeaker, "bot");
  ok("שינוי שנעשה ישירות ב-Vapi (קול, פתיח, סגירה) מופיע אצל הלקוח ברענון");

  // ---- מסך הקולות: הוספת קול של ElevenLabs עם מודל ו-ID משלו ----
  const voiceAdmin = await import("../src/server/voice-admin");
  const newVoice = {
    provider: "11labs",
    providerVoiceId: "el_noam_123",
    name: "נועם",
    gender: "male",
    description: "חם ובטוח",
    tier: "premium",
    sortOrder: 5,
    isActive: true,
    model: "eleven_v3",
    speed: 1.1,
    stability: 0.5,
  };
  await expectError("validation", () => voiceAdmin.addVoice({ ...newVoice, model: "gpt-4o" }));
  await expectError("validation", () => voiceAdmin.addVoice({ ...newVoice, speed: 2 }));
  await expectError("validation", () => voiceAdmin.addVoice({ ...newVoice, providerVoiceId: "bad id with spaces" }));
  await expectError("validation", () => voiceAdmin.addVoice({ ...newVoice, provider: "openai" }));
  const noam = await voiceAdmin.addVoice(newVoice);
  const noamVoice = { provider: "11labs", voiceId: "el_noam_123", model: "eleven_v3", speed: 1.1, stability: 0.5 };
  assert.deepEqual(noam.providerConfig, noamVoice);
  await expectError("validation", () => voiceAdmin.addVoice({ ...newVoice, name: "כפול" }));
  ok("הוספת קול ElevenLabs: נשמר עם המודל והכיוונונים. מודל, מהירות, ID או ספק לא תקינים נדחים, וכפילות נחסמת");

  // דוגמת שמע: נוצרת ב-ElevenLabs עם אותן הגדרות שיש לקול ב-Vapi
  mock.requests.length = 0;
  await voiceAdmin.generateSample(noam.id);
  const ttsReq = mock.requests.find((r) => r.path.startsWith("/v1/text-to-speech/"))!;
  assert.equal(ttsReq.path, "/v1/text-to-speech/el_noam_123?output_format=mp3_44100_128");
  const ttsBody = ttsReq.body as { model_id: string; voice_settings: unknown; text: string };
  assert.equal(ttsBody.model_id, "eleven_v3");
  assert.deepEqual(ttsBody.voice_settings, { stability: 0.5, speed: 1.1 });
  const noamSample = await voiceSample(noam.id);
  assert.ok(noamSample && Buffer.from(noamSample.audio).toString().startsWith("ID3"), "הדוגמה נשמרה");
  const missing = await voiceAdmin.addVoice({ ...newVoice, providerVoiceId: "missing_voice_1", name: "לא קיים" });
  await expectError("validation", () => voiceAdmin.generateSample(missing.id));
  // העלאת MP3: רק MP3 אמיתי, ועד 2MB
  await expectError("validation", () => voiceAdmin.uploadSample(missing.id, Buffer.from("<html>not audio</html>")));
  await expectError("validation", () => voiceAdmin.uploadSample(missing.id, Buffer.concat([Buffer.from("ID3"), Buffer.alloc(3 * 1024 * 1024)])));
  await voiceAdmin.uploadSample(missing.id, Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]));
  const { GET: getSample } = await import("../src/app/api/voice-samples/[id]/route");
  const sampleRes = await getSample(new Request("https://x"), { params: Promise.resolve({ id: missing.id }) });
  assert.equal(sampleRes.status, 200);
  assert.equal(sampleRes.headers.get("content-type"), "audio/mpeg");
  const listed = (await voiceAdmin.listVoicesAdmin()).find((v) => v.id === noam.id)!;
  assert.equal(listed.hasSample, true);
  assert.equal(listed.model, "eleven_v3");
  assert.ok(listed.sampleUrl?.startsWith(`/api/voice-samples/${noam.id}?v=`));
  ok("דוגמאות: נוצרות ב-ElevenLabs עם המודל והכיוונונים של הקול, ID שגוי מחזיר שגיאה ברורה, העלאה מקבלת רק MP3 עד 2MB");

  // ---- אבטחה: הלקוח שולח רק slug. ספק, מודל ו-ID שהוא מזייף בבקשה לא מגיעים ל-Vapi ----
  const { PUT: putBot } = await import("../src/app/api/b/[key]/bot/route");
  const { POST: postTestCall } = await import("../src/app/api/b/[key]/test-call/route");
  const routeCtx = { params: Promise.resolve({ key: roniKey }) };
  const jsonReq = (body: unknown) =>
    new Request("https://x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const forged = {
    voiceId: noam.id,
    firstSpeaker: "bot",
    openingMessage: "שלום",
    closingMessage: "",
    // כל אלה מזויפים: מישהו העתיק את הבקשה מהדפדפן והוסיף שדות
    provider: "11labs",
    model: "eleven_v4_turbo",
    providerVoiceId: "someone_expensive_voice",
    voice: { provider: "11labs", voiceId: "someone_expensive_voice", model: "eleven_v4_turbo" },
    assistantOverrides: { model: { provider: "openai", model: "gpt-4.5" } },
  };
  mock.requests.length = 0;
  const forgedRes = await putBot(jsonReq(forged), routeCtx);
  assert.equal(forgedRes.status, 200);
  const forgedPatch = mock.requests.find((r) => r.method === "PATCH")!.body as Record<string, unknown>;
  assert.deepEqual(forgedPatch.voice, noamVoice, "ל-Vapi נשלח הקול מהקטלוג, לא מה שבבקשה");
  assert.equal(forgedPatch.model, undefined, "מודל מזויף לא נשלח");
  const forgedVersion = await db.select().from(schema.botVersions).where(eq(schema.botVersions.tenantId, roni.tenant.id));
  assert.ok(forgedVersion.every((v) => !("provider" in v.settings) && !("voice" in v.settings)), "שדות זרים לא נשמרים");

  // קול שלא בקטלוג, קול כבוי, או קול שהוא אובייקט: נדחים
  const inactive = await voiceAdmin.addVoice({ ...newVoice, providerVoiceId: "el_inactive_9", name: "כבוי", isActive: false });
  for (const voiceId of ["11labs-someone_expensive_voice", "someone_expensive_voice", inactive.id, { provider: "11labs" }]) {
    const res = await putBot(jsonReq({ ...forged, voiceId }), routeCtx);
    assert.equal(res.status, 400, `voiceId ${JSON.stringify(voiceId)} היה צריך להידחות`);
  }

  // שיחת ניסיון: גם ה-override נבנה מהקטלוג בלבד
  const openForTest = await db.select().from(schema.calls).where(and(eq(schema.calls.tenantId, roni.tenant.id), eq(schema.calls.type, "test")));
  for (const t of openForTest) if (t.vapiCallId && t.status !== "ended") endCall(mock, t.vapiCallId, 5);
  mock.requests.length = 0;
  const tcRes = await postTestCall(jsonReq(forged), routeCtx);
  assert.equal(tcRes.status, 200);
  const forgedCall = mock.requests.find((r) => r.method === "POST" && r.path === "/call")!.body as {
    assistantOverrides: Record<string, unknown>;
  };
  assert.deepEqual(forgedCall.assistantOverrides.voice, noamVoice);
  assert.equal(forgedCall.assistantOverrides.model, undefined);
  ok("בקשה מזויפת עם ספק, מודל ו-ID יקרים: השרת מתעלם מהם ושולח ל-Vapi את הקול מהקטלוג. קול לא קיים או כבוי נדחה");

  // ---- הנחיות: הלקוח לא יכול להאריך אותן מעבר למגבלה, אבל יכול לשמור הנחיות ארוכות שאדמין כתב ----
  const { CUSTOMER_PROMPT_MAX } = await import("../src/lib/validation");
  const tooLong = "א".repeat(CUSTOMER_PROMPT_MAX + 1);
  const longRes = await putBot(jsonReq({ ...forged, prompt: tooLong }), routeCtx);
  assert.equal(longRes.status, 400);
  assert.ok(((await longRes.json()) as { fieldErrors?: { prompt?: string } }).fieldErrors?.prompt);
  const adminPrompt = "ב".repeat(CUSTOMER_PROMPT_MAX + 4000);
  await admin.updateAssistantPrompt("1001", adminPrompt);
  const longAccess = await findAccess(roniKey);
  if (longAccess.state !== "ok") throw new Error("לא אמור לקרות");
  assert.equal((await getBotPageData(longAccess)).promptMax, adminPrompt.length, "המגבלה בדף היא אורך ההנחיות הקיימות");
  const keepRes = await putBot(jsonReq({ ...forged, prompt: adminPrompt, openingMessage: "פתיח אחר" }), routeCtx);
  assert.equal(keepRes.status, 200, "מותר לשמור את ההנחיות הארוכות שכבר יש");
  const growRes = await putBot(jsonReq({ ...forged, prompt: adminPrompt + "עוד" }), routeCtx);
  assert.equal(growRes.status, 400, "אסור להאריך אותן");
  await admin.updateAssistantPrompt("1001", "הנחיות קצרות");
  ok(`הנחיות: לקוח מוגבל ל-${CUSTOMER_PROMPT_MAX} תווים. הנחיות ארוכות יותר שאדמין כתב נשמרות, אבל לא מתארכות`);

  // ---- שינוי מודל בקטלוג, והחלה על ה-assistants שכבר משתמשים בקול ----
  const { tuningChanged } = await voiceAdmin.updateVoice(noam.id, {
    ...newVoice,
    model: "eleven_flash_v2_5",
    speed: null,
    stability: 0.5,
  });
  assert.equal(tuningChanged, true);
  assert.equal(mock.assistants.get("asst_roni")!.voice!.model, "eleven_v3", "עד שמחילים, הבוט החי לא משתנה");
  mock.assistants.set("asst_other", { id: "asst_other", name: "אחר", voice: itaiVoice });
  mock.requests.length = 0;
  const applied = await voiceAdmin.applyVoiceToAssistants(noam.id);
  assert.deepEqual(applied, { updated: ["מספרת רוני"], failed: [] });
  assert.deepEqual(mock.assistants.get("asst_roni")!.voice, { provider: "11labs", voiceId: "el_noam_123", model: "eleven_flash_v2_5", stability: 0.5 });
  assert.equal(mock.requests.filter((r) => r.method === "PATCH").length, 1, "רק ה-assistant שמשתמש בקול מתעדכן");
  // מודל שהגיע מ-Vapi ולא ברשימה שלנו לא חוסם עריכה של השם
  await db.update(schema.voices).set({ providerConfig: { ...noamVoice, model: "eleven_future_v9" } }).where(eq(schema.voices.id, noam.id));
  await voiceAdmin.updateVoice(noam.id, { ...newVoice, model: "eleven_future_v9", name: "נועם 2" });
  await expectError("validation", () => voiceAdmin.updateVoice(noam.id, { ...newVoice, model: "eleven_other_v9" }));
  ok("שינוי מודל בקטלוג: חל על בחירות חדשות, ו'החלה' מעדכנת רק assistants שמדברים בקול הזה ב-Vapi");

  // ---- כפילויות: assistant אחד ללקוח אחד ----
  const dup = { name: "כפול", externalCustomerId: "9999", vapiAssistantId: "asst_roni" };
  await expectError("validation", () => admin.createCustomer(dup));
  await expectError("validation", () => admin.createCustomer({ ...dup, vapiAssistantId: "asst_demo" }));
  await expectError("validation", () => admin.createCustomer({ ...dup, vapiAssistantId: "asst_other", externalCustomerId: "1001" }));
  const { cached } = await import("../src/server/memo");
  let loads = 0;
  const load = async () => ++loads;
  await cached("t", 60_000, load);
  await cached("t", 60_000, load);
  assert.equal(loads, 1, "בתוך הזמן: מהזיכרון");
  assert.equal(await cached("t", 60_000, load, { fresh: true }), 2, "רענון טוען מחדש");
  ok("assistant שכבר מחובר ללקוח, ה-assistant של הדמואים, או מזהה חיצוני תפוס נחסמים. 'רענון מ-Vapi' עוקף את הזיכרון");

  // 9. דמו: 5 דקות, maxDurationSeconds לפי היתרה
  const demo = await admin.createDemo({ name: "קליניקת שקד", verifiedPhone: "0521234567" });
  const demoKey = keyFromUrl(demo.url);
  mock.requests.length = 0;
  const d1 = await startTestCall(demoKey, { voiceId: itaiId, firstSpeaker: "bot", openingMessage: "שלום", closingMessage: "" }, meta);
  assert.equal(d1.demoRemainingSeconds, 300);
  const demoPost = mock.requests.find((r) => r.method === "POST")!.body as { assistantId: string; phoneNumberId: string; assistantOverrides: { maxDurationSeconds: number } };
  assert.equal(demoPost.assistantId, "asst_demo");
  assert.equal(demoPost.phoneNumberId, "pn_test");
  assert.equal(demoPost.assistantOverrides.maxDurationSeconds, 300);
  const [demoCall] = await db.select().from(schema.calls).where(eq(schema.calls.tenantId, demo.tenant.id));
  endCall(mock, demoCall.vapiCallId!, 290);
  await expectError("demo_ended", () => startTestCall(demoKey, { voiceId: itaiId, firstSpeaker: "bot", openingMessage: "שלום", closingMessage: "" }, meta));
  const demoAccess = await findAccess(demoKey);
  assert.equal(demoAccess.state, "ok");
  if (demoAccess.state === "ok") {
    const demoPage = await getBotPageData(demoAccess);
    assert.equal(demoPage.plan.type, "demo");
    if (demoPage.plan.type === "demo") assert.equal(demoPage.plan.remainingSeconds, 10);
  }
  ok("דמו: יוצא מה-assistant המשותף, מוגבל ל-300 שניות. אחרי 290 שניות נשארו 10, ושיחה נוספת נחסמת");

  // 9ב. עלות של דמו: השיחות רצות על ה-assistant המשותף, והעלות הסופית מגיעה מ-Vapi אחרי הסיום
  const demoVapiCall = mock.calls.get(demoCall.vapiCallId!)!;
  mock.calls.set(demoCall.vapiCallId!, {
    ...demoVapiCall,
    cost: 0.42,
    costBreakdown: { llm: 0.2, tts: 0.12, stt: 0.04, transport: 0.03, vapi: 0.03, total: 0.42 },
    updatedAt: new Date().toISOString(),
  });
  // שיחה אחרת על ה-assistant המשותף, שלא נוצרה מהדשבורד: לא נכנסת
  mock.calls.set("call_demo_other", { id: "call_demo_other", type: "inboundPhoneCall", status: "ended", assistantId: "asst_demo", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cost: 9 });
  const demoDetail = await admin.tenantDetail(demo.tenant.id);
  assert.equal(demoDetail.costPeriod.kind, "demo");
  near(demoDetail.cost!.totalUsd, 0.42, "העלות הסופית של הדמו");
  near(demoDetail.cost!.ttsUsd, 0.12, "קול בדמו");
  assert.equal(demoDetail.previousCostUsd, null);
  assert.equal((await db.select().from(schema.calls).where(eq(schema.calls.vapiCallId, "call_demo_other"))).length, 0);
  ok("עלות דמו: מתעדכנת מ-Vapi גם אחרי שהשיחה הסתיימה. שיחות זרות על ה-assistant המשותף לא נכנסות");

  // 10. עדכון בדמו לא נוגע ב-Vapi
  mock.requests.length = 0;
  await updateBot(demoKey, { voiceId: itaiId, firstSpeaker: "bot", openingMessage: "פתיח של דמו", closingMessage: "" }, meta);
  assert.equal(mock.requests.filter((r) => r.method === "PATCH").length, 0);
  ok("עדכון בדמו נשמר ב-DB בלבד, בלי לגעת באף assistant");
  const demoHist = await (await import("../src/server/versions")).listVersions(await admin.findTenant(demo.tenant.id));
  mock.requests.length = 0;
  await (await import("../src/server/versions")).restoreVersion(await admin.findTenant(demo.tenant.id), demoHist.versions.at(-1)!.id);
  assert.equal(mock.requests.filter((r) => r.method === "PATCH").length, 0, "שחזור בדמו לא נוגע ב-Vapi");
  const demoAfter = await admin.findTenant(demo.tenant.id);
  const [demoCurrent] = await db.select().from(schema.botVersions).where(eq(schema.botVersions.id, demoAfter.currentVersionId!));
  assert.equal(demoCurrent.settings.openingMessage, demoHist.versions.at(-1)!.settings.openingMessage);
  // וחזרה לגרסה עם "פתיח של דמו", כי ההמרה ללקוח בהמשך בודקת אותו
  await (await import("../src/server/versions")).restoreVersion(demoAfter, demoHist.versions[0].id);
  ok("שחזור גרסה בדמו: רק ב-DB");

  // 11. הפיכת דמו ללקוח: ההגדרות מהדמו עוברות ל-assistant שלו
  await admin.convertDemo(demo.tenant.id, { externalCustomerId: "1002", vapiAssistantId: "asst_dental" });
  assert.equal(mock.assistants.get("asst_dental")!.firstMessage, "פתיח של דמו");
  const converted = await findAccess(demoKey);
  assert.equal(converted.state, "ok");
  if (converted.state === "ok") assert.equal(converted.tenant.type, "customer");
  ok("הפיכת דמו ללקוח: מה שהוגדר בדמו נשלח ל-assistant, והקישור הקיים ממשיך לעבוד");

  // 12. קישורים: הנפקה מחדש מבטלת את הישן
  const fresh = await admin.issueLink("1001", { label: "המזכירה" });
  assert.equal((await findAccess(roniKey)).state, "invalid");
  assert.equal((await findAccess(keyFromUrl(fresh.url))).state, "ok");
  await admin.revokeLinks("1001");
  assert.equal((await findAccess(keyFromUrl(fresh.url))).state, "invalid");
  assert.equal((await findAccess("x".repeat(43))).state, "invalid");
  ok("קישור חדש מבטל את הקודם, וביטול מנתק מיד. מפתח מומצא לא נכנס");

  // 13. השעיה ותפוגת דמו
  const demo2 = await admin.createDemo({ name: "דמו שפג", days: 7 });
  await admin.setTenantStatus(demo2.tenant.id, "suspended");
  assert.equal((await findAccess(keyFromUrl(demo2.url))).state, "suspended");
  await admin.setTenantStatus(demo2.tenant.id, "active");
  await db.update(schema.tenants).set({ demoExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.tenants.id, demo2.tenant.id));
  assert.equal((await findAccess(keyFromUrl(demo2.url))).state, "demo_expired");
  ok("לקוח מושהה ודמו שפג לא נכנסים לדף");

  // 14. API פנימי
  const req = (auth?: string) => new Request("https://x/api/internal/usage", { headers: auth ? { authorization: auth } : {} });
  assert.equal(checkInternalAuth(req())?.status, 401);
  assert.equal(checkInternalAuth(req("Bearer wrong"))?.status, 401);
  assert.equal(checkInternalAuth(req("Bearer a-very-long-internal-secret-123")), null);
  ok("ה-API הפנימי דורש את הסוד המשותף");

  // מיגרציות: הפאנל יודע להגיד כשיש מיגרציה שלא הורצה
  const { pendingMigrations } = await import("../src/server/db-health");
  assert.equal(await pendingMigrations(), 0);
  await db.execute(sql`delete from drizzle.__drizzle_migrations where created_at = (select max(created_at) from drizzle.__drizzle_migrations)`);
  assert.equal(await pendingMigrations(), 1);
  // בלי טבלת sync_state (מיגרציה 0006 לא הורצה): הסנכרון עובד כמו פעם, הכול מתחילת התקופה
  await db.execute(sql`drop table sync_state`);
  mock.requests.length = 0;
  await syncTenantCalls(roni.tenant, from);
  assert.equal(askedSince(), from.toISOString());
  ok("מיגרציה שלא הורצה: הפאנל מזהה אותה. בלי טבלת sync_state הסנכרון חוזר לעבוד כמו פעם, במקום להיכשל");

  // אחרון, כי משנה את מבנה ה-DB: אם מיגרציה 0005 לא הורצה, עמוד הלקוח בפאנל מסביר מה לעשות במקום לקרוס
  await db.execute(sql`alter table calls drop column cost_breakdown`);
  const noColumn = await admin.tenantDetail("1001");
  assert.equal(noColumn.cost, null);
  assert.match(noColumn.costError ?? "", /db:migrate/);
  assert.ok(noColumn.links.length > 0, "שאר העמוד עובד");
  ok("DB בלי מיגרציה 0005: עמוד הלקוח בפאנל נטען, ובמקום העלות מופיעה הוראה להריץ את המיגרציה");

  console.log("\nהכול עבר.");
  await mock.close();
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
