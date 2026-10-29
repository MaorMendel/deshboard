import { requestMeta } from "@/server/access";
import { parseSettings, startTestCall } from "@/server/bot-service";
import { errorResponse } from "@/server/errors";

/** נסה את הבוט: מתקשר לטלפון המאומת של בעל העסק עם ההגדרות שעל המסך */
export async function POST(request: Request, ctx: RouteContext<"/api/b/[key]/test-call">) {
  try {
    const { key } = await ctx.params;
    const settings = parseSettings(await request.json().catch(() => null));
    return Response.json(await startTestCall(key, settings, requestMeta(request)));
  } catch (err) {
    return errorResponse(err);
  }
}
