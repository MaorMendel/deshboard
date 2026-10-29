// לקוח קטן ל-API של Cartesia (https://docs.cartesia.ai/api-reference). משמש רק את פקודות הקולות.

import { config } from "./config";

const CARTESIA_VERSION = "2026-08-14";

async function cartesiaFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const key = config.cartesiaApiKey();
  if (!key) throw new Error("CARTESIA_API_KEY לא מוגדר. play.cartesia.ai -> API Keys.");
  const res = await fetch(`https://api.cartesia.ai${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Cartesia-Version": CARTESIA_VERSION,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Cartesia החזיר ${res.status}: ${body.slice(0, 300)}`);
  }
  return res;
}

export interface CartesiaVoiceInfo {
  id: string;
  name: string;
  description?: string;
  language?: string;
  gender?: "masculine" | "feminine" | "gender_neutral" | null;
}

export const cartesia = {
  /** פרטי קול לפי ה-ID שלו. זורק אם הקול לא קיים או לא נגיש מהחשבון. */
  async getVoice(voiceId: string): Promise<CartesiaVoiceInfo> {
    const res = await cartesiaFetch(`/voices/${encodeURIComponent(voiceId)}`);
    return (await res.json()) as CartesiaVoiceInfo;
  },

  /** הקראה של טקסט לקובץ mp3 */
  async tts(body: Record<string, unknown>): Promise<Buffer> {
    const res = await cartesiaFetch("/tts/bytes", { method: "POST", body: JSON.stringify(body) });
    return Buffer.from(await res.arrayBuffer());
  },
};
