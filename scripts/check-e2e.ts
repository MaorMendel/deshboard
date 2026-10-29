// npm run check:e2e
// בדיקה מקצה לקצה של כל הזרימות, מול Postgres בזיכרון ושרת Vapi מדומה.
// לא צריך Postgres, מפתח Vapi או אינטרנט.

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
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

  // 10. עדכון בדמו לא נוגע ב-Vapi
  mock.requests.length = 0;
  await updateBot(demoKey, { voiceId: itaiId, firstSpeaker: "bot", openingMessage: "פתיח של דמו", closingMessage: "" }, meta);
  assert.equal(mock.requests.filter((r) => r.method === "PATCH").length, 0);
  ok("עדכון בדמו נשמר ב-DB בלבד, בלי לגעת באף assistant");

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

  console.log("\nהכול עבר.");
  await mock.close();
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
