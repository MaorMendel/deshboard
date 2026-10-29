// מגיש את דוגמת השמע של קול מתוך ה-DB. פתוח (בלי מפתח), כי זו הקלטה של משפט כללי
// שאין בה שום מידע על לקוח. הדפדפן מקבל אותה מכתובת עם ?v=, ולכן אפשר לשמור אותה במטמון לאורך זמן.

import { voiceSample } from "@/server/voice-samples";

export async function GET(_request: Request, ctx: RouteContext<"/api/voice-samples/[id]">) {
  const { id } = await ctx.params;
  const sample = await voiceSample(id);
  if (!sample) return new Response("not found", { status: 404 });

  return new Response(new Uint8Array(sample.audio), {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(sample.audio.length),
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"${sample.updatedAt.getTime()}"`,
    },
  });
}
