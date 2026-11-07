// לקוח קטן ל-API של ElevenLabs (https://elevenlabs.io/docs/api-reference). משמש רק ליצירת דוגמאות שמע.
// השיחות עצמן לא עוברות כאן: Vapi מדבר עם ElevenLabs ישירות, עם החיבור שמוגדר אצלו.

import { config } from "./config";

export function isElevenLabsConfigured(): boolean {
  return config.elevenlabs.apiKey().length > 0;
}

export const elevenlabs = {
  /** הקראה של טקסט לקובץ mp3 */
  async tts(voiceId: string, body: Record<string, unknown>): Promise<Buffer> {
    const key = config.elevenlabs.apiKey();
    if (!key) throw new Error("ELEVENLABS_API_KEY לא מוגדר בשרת. elevenlabs.io -> Developers -> API Keys.");
    const res = await fetch(
      `${config.elevenlabs.baseUrl()}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ElevenLabs החזיר ${res.status}: ${text.slice(0, 300)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  },
};
