// npm run dev:local
// מריץ את כל המערכת על המחשב, בלי Supabase ובלי Vapi:
// Postgres בזיכרון, Vapi מדומה (שיחות ניסיון "מסתיימות" לבד אחרי 20 שניות), לקוח ודמו לדוגמה, והאתר עצמו.
// הכול נמחק כשעוצרים (Ctrl+C). לא נוגע בשום נתון אמיתי.

import { spawn } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { startMockVapi } from "./mock-vapi";

const DB_PORT = 54329;
const VAPI_PORT = 54330;
const APP_PORT = Number(process.env.PORT ?? 3000);
const MOCK_KEY = "local-mock-key";
const mode = process.argv.includes("--start") ? "start" : "dev";

async function main() {
  const pglite = await PGlite.create();
  const pg = drizzle(pglite, { schema: await import("../src/db/schema") });
  await migrate(pg, { migrationsFolder: "./drizzle" });

  const mock = await startMockVapi(MOCK_KEY, { port: VAPI_PORT, autoEndCallsAfterMs: 20_000 });
  const env = {
    APP_URL: `http://localhost:${APP_PORT}`,
    DATABASE_URL: `postgres://postgres@127.0.0.1:${DB_PORT}/postgres`,
    DATABASE_POOL_MAX: "1",
    VAPI_BASE_URL: mock.url,
    VAPI_PRIVATE_KEY: MOCK_KEY,
    VAPI_DEMO_ASSISTANT_ID: "asst_demo",
    VAPI_TEST_PHONE_NUMBER_ID: "pn_test",
    // ElevenLabs מדומה (על אותו שרת), כדי שאפשר יהיה לנסות "ליצור דוגמה" בלי חשבון
    ELEVENLABS_BASE_URL: mock.url,
    ELEVENLABS_API_KEY: MOCK_KEY,
    INTERNAL_API_SECRET: "local-internal-secret-0123456789",
    ADMIN_PASSWORD: "local-admin-1234",
  };
  Object.assign(process.env, env);

  // מספרים לדוגמה, לתפריט הבחירה בפאנל הניהול
  mock.phoneNumbers.set("pn_test", { id: "pn_test", number: "+97233763805", name: "המספר הכללי" });
  mock.phoneNumbers.set("pn_roni", { id: "pn_roni", number: "+97245550182", name: "מספרת רוני" });

  // assistants לדוגמה, כמו שיש לך ב-Vapi
  const voice = (voiceId: string) => ({ provider: "cartesia", voiceId, model: "sonic-3.6", language: "he" });
  mock.assistants.set("asst_roni", {
    id: "asst_roni",
    name: "מספרת רוני",
    voice: voice("ca_noa"),
    firstMessage: "שלום, הגעתם למספרת רוני, מדברת נועה. איך אפשר לעזור?",
    firstMessageMode: "assistant-speaks-first",
    endCallMessage: "תודה שהתקשרתם למספרת רוני, יום טוב!",
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "system", content: "את נציגת שירות של מספרת רוני. עני בעברית, קצר ולעניין, ועזרי לקבוע תורים." }],
    },
  });
  mock.assistants.set("asst_clinic", { id: "asst_clinic", name: "קליניקה", voice: voice("ca_itai") });
  mock.assistants.set("asst_office", { id: "asst_office", name: "משרד", voice: voice("ca_michal") });
  mock.assistants.set("asst_demo", { id: "asst_demo", name: "Demo", voice: voice("ca_noa") });

  const { setDbForTests } = await import("../src/db");
  setDbForTests(pg as never);
  const schema = await import("../src/db/schema");
  const { importVoicesFromVapi } = await import("../src/server/voice-catalog");
  const admin = await import("../src/server/admin-service");

  await importVoicesFromVapi();
  const names: Record<string, [string, "female" | "male", string]> = {
    ca_noa: ["נועה", "female", "חמה ורגועה"],
    ca_itai: ["איתי", "male", "ענייני ומקצועי"],
    ca_michal: ["מיכל", "female", "רכה, מתאימה לקליניקות"],
  };
  for (const [id, [name, gender, description]] of Object.entries(names)) {
    await pg.update(schema.voices).set({ name, gender, description, isActive: true }).where(eq(schema.voices.providerVoiceId, id));
  }

  const customer = await admin.createCustomer({
    name: "מספרת רוני",
    externalCustomerId: "1001",
    vapiAssistantId: "asst_roni",
    vapiPhoneNumberId: "pn_roni",
    botPhoneDisplay: "04-555-0182",
    verifiedPhone: "0501234471",
    planStartedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    planMinutes: 100,
  });
  const demo = await admin.createDemo({ name: "קליניקת שקד", verifiedPhone: "0521234567" });

  // כמה שיחות עבר עם מחיר, כדי שבפאנל יהיה מה לראות בדקות ובעלות
  const DAY = 24 * 60 * 60 * 1000;
  for (let i = 0; i < 6; i++) {
    const start = Date.now() - (i + 1) * DAY * 1.3 - 3_600_000;
    const seconds = 60 + i * 47;
    const minutes = seconds / 60;
    const parts = { llm: 0.035 * minutes, tts: 0.03 * minutes, stt: 0.01 * minutes, transport: 0.012 * minutes, vapi: 0.05 * minutes };
    const total = Object.values(parts).reduce((a, b) => a + b, 0) + 0.004;
    mock.calls.set(`call_past_${i}`, {
      id: `call_past_${i}`,
      type: "inboundPhoneCall",
      status: "ended",
      assistantId: "asst_roni",
      customer: { number: `+97250000000${i}` },
      createdAt: new Date(start).toISOString(),
      updatedAt: new Date(start + seconds * 1000).toISOString(),
      startedAt: new Date(start).toISOString(),
      endedAt: new Date(start + seconds * 1000).toISOString(),
      cost: total,
      costBreakdown: { ...parts, total, analysisCostBreakdown: { summary: 0.004 } },
    });
  }
  const { syncTenantCalls } = await import("../src/server/call-sync");
  await syncTenantCalls(customer.tenant, new Date(Date.now() - 30 * DAY));

  const socket = new PGLiteSocketServer({ db: pglite, port: DB_PORT, host: "127.0.0.1" });
  await socket.start();

  const child = spawn("npx", ["next", mode, "-p", String(APP_PORT)], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });

  console.log(`
סביבה מקומית עם נתוני דמו (Vapi מדומה, שום דבר לא נשלח באמת):

  לקוח משלם:  ${customer.url}
  דמו:        ${demo.url}
  פאנל ניהול: http://localhost:${APP_PORT}/admin  (סיסמה: ${env.ADMIN_PASSWORD})

שיחת ניסיון "מתחילה" אחרי 3 שניות ו"מסתיימת" אחרי 20 שניות.
עוצרים עם Ctrl+C.
`);

  const stop = async () => {
    child.kill("SIGINT");
    await socket.stop();
    await mock.close();
    await pglite.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
