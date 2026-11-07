import { versionHistory } from "@/server/bot-service";
import { errorResponse } from "@/server/errors";

/** הגרסאות הקודמות של הבוט, לחזרה אחורה מהדף של הלקוח. קריאה בלבד: חזרה לגרסה עוברת ב-PUT הרגיל של /bot. */
export async function GET(_request: Request, ctx: RouteContext<"/api/b/[key]/versions">) {
  try {
    const { key } = await ctx.params;
    return Response.json({ versions: await versionHistory(key) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
