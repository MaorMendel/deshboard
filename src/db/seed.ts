// נתונים לסביבת פיתוח בלבד: קולות לדוגמה, לקוח לדוגמה ודמו לדוגמה.
// בפרודקשן לא מריצים את זה. שם מייבאים קולות מ-Vapi ומוסיפים לקוחות אמיתיים.

import { eq } from "drizzle-orm";
import type { BotSettings } from "../lib/types";
import { PLACEHOLDER_VOICES } from "../server/voice-catalog";
import { generateAccessKey, hashAccessKey } from "./access-keys";
import type { Db } from "./index";
import { accessLinks, botVersions, tenants, voices } from "./schema";

export interface SeedResult {
  customerKey: string;
  demoKey: string;
}

export async function seed(db: Db): Promise<SeedResult> {
  await db
    .insert(voices)
    .values(PLACEHOLDER_VOICES.map((v, i) => ({ ...v, sortOrder: i })))
    .onConflictDoNothing();

  const customerKey = await createTenantWithVersion(db, {
    tenant: {
      externalCustomerId: "DEMO-CUST-1001",
      name: "מספרת רוני",
      type: "customer",
      vapiAssistantId: "asst_demo_roni",
      vapiPhoneNumberId: "pn_demo_roni",
      botPhoneDisplay: "04-555-0182",
      verifiedPhone: "+972501234471",
    },
    settings: {
      voiceId: "noa",
      firstSpeaker: "bot",
      openingMessage: "שלום, הגעתם למספרת רוני, מדברת נועה. איך אפשר לעזור?",
      closingMessage: "תודה שהתקשרתם למספרת רוני, יום טוב!",
    },
    linkLabel: "רוני",
  });

  const demoKey = await createTenantWithVersion(db, {
    tenant: {
      name: "קליניקת שקד",
      type: "demo",
      demoSecondsLimit: 300,
      demoExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      verifiedPhone: "+972521234567",
    },
    settings: {
      voiceId: "michal",
      firstSpeaker: "bot",
      openingMessage: "שלום, הגעתם לקליניקת שקד. במה אפשר לעזור?",
      closingMessage: "תודה ולהתראות.",
    },
    linkLabel: "דמו",
  });

  return { customerKey, demoKey };
}

async function createTenantWithVersion(
  db: Db,
  input: { tenant: typeof tenants.$inferInsert; settings: BotSettings; linkLabel: string },
): Promise<string> {
  return db.transaction(async (tx) => {
    const [tenant] = await tx.insert(tenants).values(input.tenant).returning({ id: tenants.id });
    const [version] = await tx
      .insert(botVersions)
      .values({ tenantId: tenant.id, version: 1, settings: input.settings, createdByType: "system" })
      .returning({ id: botVersions.id });
    await tx.update(tenants).set({ currentVersionId: version.id }).where(eq(tenants.id, tenant.id));

    const key = generateAccessKey();
    await tx.insert(accessLinks).values({ tenantId: tenant.id, tokenHash: hashAccessKey(key), label: input.linkLabel });
    return key;
  });
}
