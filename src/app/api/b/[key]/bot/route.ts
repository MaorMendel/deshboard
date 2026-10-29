import type { BotSettings } from "@/lib/types";
import { requestMeta } from "@/server/access";
import { parseSettings, updateBot } from "@/server/bot-service";
import { errorResponse } from "@/server/errors";

/** עדכן את הבוט */
export async function PUT(request: Request, ctx: RouteContext<"/api/b/[key]/bot">) {
  try {
    const { key } = await ctx.params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const settings = parseSettings(body);
    // baseline: ההגדרות כפי שהמסך טען אותן, כדי לכתוב ל-Vapi רק את מה שהלקוח שינה.
    // דפדפן ישן לא שולח אותן, ואז נכתבים כל השדות.
    let baseline: BotSettings | undefined;
    try {
      baseline = parseSettings(body?.baseline);
    } catch {
      baseline = undefined;
    }
    return Response.json(await updateBot(key, settings, requestMeta(request), baseline));
  } catch (err) {
    return errorResponse(err);
  }
}
