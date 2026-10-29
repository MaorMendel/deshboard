// פקודות ניהול זמניות, עד שפאנל הניהול יהיה מוכן. כל אחת קוראת לפונקציה ב-src/server/admin-service.ts.
// הסבר מלא על כל פקודה: README.md, בפרק "ניהול שוטף"

import { parseArgs } from "node:util";

try {
  process.loadEnvFile(".env");
} catch {
  // אין .env, משתמשים במשתני הסביבה של המערכת
}

const HELP = `
פקודות:
  npm run voices:import
      מייבא את הקולות מכל ה-assistants בחשבון Vapi לטבלת voices (נכנסים כבויים)

  npm run voices:add -- --voice <cartesia voice id> [--name "נועה"] [--gender female|male] [--description "חמה ורגועה"]
                        [--tier premium] [--model sonic-3.6] [--speed 1.1] [--order 10] [--inactive]
      מוסיף קול של Cartesia לפי ה-ID שלו (או מעדכן אם כבר קיים), מפעיל אותו ומייצר לו דוגמת שמע

  npm run voices:samples -- [--voice <id>] [--force] [--text "..."] [--model sonic-3.6]
      מייצר ב-Cartesia דוגמת שמע קצרה לכל קול שאין לו, ושומר ב-public/voice-samples

  npm run customer:add -- --name "מספרת רוני" --external-id 1001 --assistant <assistantId>
                          [--phone-number <phoneNumberId>] [--bot-phone "04-555-0182"] [--test-phone 0501234567]
      מחבר לקוח קיים: קורא את ההגדרות הנוכחיות של ה-assistant ומנפיק קישור

  npm run demo:add -- --name "קליניקת שקד" --test-phone 0521234567 [--minutes 5] [--days 7]
      יוצר דמו ומנפיק קישור

  npm run demo:convert -- --tenant <id> --external-id 1002 --assistant <assistantId> [--phone-number <id>] [--bot-phone "..."]
      הופך דמו ללקוח משלם ושולח ל-assistant את מה שהוא הגדיר בדמו

  npm run link:new -- --tenant <external-id או id> [--label "המזכירה"] [--keep-old]
      מנפיק קישור חדש (ומבטל את הקודמים, אלא אם --keep-old)

  npm run link:revoke -- --tenant <external-id או id>
      מבטל את כל הקישורים של הלקוח

  npm run tenant:suspend -- --tenant <...>    /    npm run tenant:activate -- --tenant <...>

  npm run calls:sync -- [--hours 24]
      מושך מ-Vapi את השיחות שהשתנו בשעות האחרונות
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    "external-id": { type: "string" },
    assistant: { type: "string" },
    "phone-number": { type: "string" },
    "bot-phone": { type: "string" },
    "test-phone": { type: "string" },
    tenant: { type: "string" },
    label: { type: "string" },
    "keep-old": { type: "boolean" },
    minutes: { type: "string" },
    days: { type: "string" },
    hours: { type: "string" },
    voice: { type: "string" },
    force: { type: "boolean" },
    text: { type: "string" },
    model: { type: "string" },
    gender: { type: "string" },
    description: { type: "string" },
    tier: { type: "string" },
    speed: { type: "string" },
    order: { type: "string" },
    inactive: { type: "boolean" },
    help: { type: "boolean" },
  },
});

function need(name: keyof typeof values): string {
  const v = values[name];
  if (typeof v !== "string" || !v.trim()) {
    console.error(`חסר --${name}\n${HELP}`);
    process.exit(1);
  }
  return v.trim();
}

async function main() {
  const command = positionals[0];
  if (!command || values.help) {
    console.log(HELP);
    return;
  }

  // ייבוא אחרי טעינת .env
  const admin = await import("../src/server/admin-service");
  const { importVoicesFromVapi, addCartesiaVoice } = await import("../src/server/voice-catalog");
  const { syncAllCalls } = await import("../src/server/call-sync");
  const { generateVoiceSamples } = await import("../src/server/voice-samples");

  switch (command) {
    case "voices:import": {
      const r = await importVoicesFromVapi();
      console.log(`נסרקו ${r.assistantsScanned} assistants, נמצאו ${r.voices.length} קולות שונים:`);
      for (const v of r.voices) {
        console.log(`  ${v.isNew ? "חדש " : "קיים"}  ${v.id}  (${v.name})  בשימוש אצל: ${v.usedBy.join(", ")}`);
      }
      console.log("\nקולות חדשים נכנסים כבויים. ב-Supabase -> Table Editor -> voices: לתת שם, מגדר ותיאור, ולסמן is_active.");
      break;
    }
    case "voices:add": {
      const gender = values.gender;
      if (gender && gender !== "female" && gender !== "male") throw new Error("--gender צריך להיות female או male");
      const tier = values.tier;
      if (tier && tier !== "standard" && tier !== "premium") throw new Error("--tier צריך להיות standard או premium");
      const { voice, isNew } = await addCartesiaVoice({
        voiceId: need("voice"),
        name: values.name,
        gender: gender as "female" | "male" | undefined,
        description: values.description,
        tier: tier as "standard" | "premium" | undefined,
        model: values.model,
        speed: values.speed ? Number(values.speed) : undefined,
        sortOrder: values.order ? Number(values.order) : undefined,
        // "להוסיף קול" פירושו שהוא יוצע ללקוחות. גם קול שהיה כבוי (למשל מ-voices:import) נדלק.
        active: !values.inactive,
      });
      console.log(`${isNew ? "נוסף" : "עודכן"} הקול ${voice.name} (${voice.gender === "female" ? "נשי" : "גברי"}), id: ${voice.id}`);
      // דוגמה נוצרת כשאין, או כשהצליל עצמו השתנה. שינוי שם או תיאור לא מייצר קובץ חדש.
      const [sample] = await generateVoiceSamples({
        voiceId: voice.id,
        force: Boolean(values.model || values.speed || values.text),
        text: values.text,
      });
      console.log(
        sample.status === "created"
          ? "דוגמת השמע נוצרה ונשמרה ב-DB. היא זמינה מיד, בלי להפעיל מחדש את השרת."
          : `דוגמת שמע: ${sample.reason}`,
      );
      console.log(voice.isActive ? "הקול פעיל ומופיע אצל הלקוחות." : "הקול כבוי. להפעלה: להריץ שוב בלי --inactive.");
      break;
    }
    case "voices:samples": {
      const r = await generateVoiceSamples({ voiceId: values.voice, force: values.force, text: values.text, model: values.model });
      const label = { created: "נוצרה", skipped: "דולג ", failed: "נכשל " } as const;
      for (const v of r) console.log(`  ${label[v.status]}  ${v.id}  (${v.name})${v.reason ? `  ${v.reason}` : ""}`);
      const created = r.filter((v) => v.status === "created").length;
      console.log(`\nנוצרו ${created} דוגמאות ב-public/voice-samples. בשרת אמיתי צריך להעלות את הקבצים יחד עם הקוד.`);
      if (r.some((v) => v.status === "failed")) process.exitCode = 1;
      break;
    }
    case "customer:add": {
      const r = await admin.createCustomer({
        name: need("name"),
        externalCustomerId: need("external-id"),
        vapiAssistantId: need("assistant"),
        vapiPhoneNumberId: values["phone-number"],
        botPhoneDisplay: values["bot-phone"],
        verifiedPhone: values["test-phone"],
      });
      console.log(`נוצר הלקוח ${r.tenant.name}.\nהקישור שלו (מוצג רק עכשיו):\n\n  ${r.url}\n`);
      break;
    }
    case "demo:add": {
      const r = await admin.createDemo({
        name: need("name"),
        verifiedPhone: values["test-phone"],
        minutes: values.minutes ? Number(values.minutes) : undefined,
        days: values.days ? Number(values.days) : undefined,
      });
      console.log(`נוצר הדמו ${r.tenant.name} (id: ${r.tenant.id}).\nהקישור שלו (מוצג רק עכשיו):\n\n  ${r.url}\n`);
      break;
    }
    case "demo:convert": {
      const t = await admin.convertDemo(need("tenant"), {
        externalCustomerId: need("external-id"),
        vapiAssistantId: need("assistant"),
        vapiPhoneNumberId: values["phone-number"],
        botPhoneDisplay: values["bot-phone"],
      });
      console.log(`${t.name} הוא עכשיו לקוח משלם. הקישור הקיים שלו ממשיך לעבוד.`);
      break;
    }
    case "link:new": {
      const r = await admin.issueLink(need("tenant"), { label: values.label, revokeOthers: !values["keep-old"] });
      console.log(`קישור חדש ל-${r.tenant.name} (מוצג רק עכשיו):\n\n  ${r.url}\n`);
      if (!values["keep-old"]) console.log("הקישורים הקודמים בוטלו.");
      break;
    }
    case "link:revoke": {
      const r = await admin.revokeLinks(need("tenant"));
      console.log(`בוטלו ${r.revoked} קישורים של ${r.tenant.name}.`);
      break;
    }
    case "tenant:suspend":
    case "tenant:activate": {
      const t = await admin.setTenantStatus(need("tenant"), command === "tenant:suspend" ? "suspended" : "active");
      console.log(`${t.name}: ${t.status === "suspended" ? "מושהה" : "פעיל"}.`);
      break;
    }
    case "calls:sync": {
      const hours = Number(values.hours ?? 24);
      const r = await syncAllCalls(new Date(Date.now() - hours * 60 * 60 * 1000));
      console.log(`עודכנו ${r.refreshedTests} שיחות ניסיון.`);
      for (const t of r.tenants) console.log(`  ${t.tenant}: ${t.fetched} שיחות${t.error ? ` (שגיאה: ${t.error})` : ""}`);
      break;
    }
    default:
      console.error(`פקודה לא מוכרת: ${command}\n${HELP}`);
      process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
