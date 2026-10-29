// שכבת ה-API של הדפדפן. כל קריאה לשרת עוברת מכאן.

import type { ApiErrorBody, BotSettings, TestCallResult, UpdateResult } from "./types";

export class ApiRequestError extends Error {
  constructor(
    public readonly body: ApiErrorBody,
    public readonly status: number,
  ) {
    super(body.message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
      credentials: "same-origin",
    });
  } catch {
    throw new ApiRequestError(
      { code: "server", message: "אין חיבור לשרת. כדאי לבדוק את החיבור לאינטרנט ולנסות שוב." },
      0,
    );
  }

  if (!res.ok) {
    let body: ApiErrorBody = { code: "server", message: "משהו השתבש בשרת. אפשר לנסות שוב בעוד רגע." };
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      // התשובה לא הייתה JSON, נשארים עם הודעת ברירת המחדל
    }
    throw new ApiRequestError(body, res.status);
  }

  return (await res.json()) as T;
}

export interface BotApi {
  /** baseline: ההגדרות כפי שהמסך טען אותן. לפיהן השרת כותב ל-Vapi רק את מה שהלקוח שינה. */
  update(settings: BotSettings, baseline: BotSettings): Promise<UpdateResult>;
  testCall(settings: BotSettings): Promise<TestCallResult>;
}

/** ה-API של לקוח אחד. המפתח שב-URL מזהה את הלקוח, ולכן כל הקריאות עוברות דרכו. */
export function createBotApi(accessKey: string): BotApi {
  const base = `/api/b/${encodeURIComponent(accessKey)}`;
  return {
    /** שומר את ההגדרות ומעדכן את הבוט החי */
    update: (settings, baseline) =>
      request<UpdateResult>(`${base}/bot`, {
        method: "PUT",
        body: JSON.stringify({ ...settings, baseline }),
      }),
    /** מתקשר לטלפון של בעל העסק עם ההגדרות שעל המסך, גם אם עוד לא עודכנו */
    testCall: (settings) =>
      request<TestCallResult>(`${base}/test-call`, { method: "POST", body: JSON.stringify(settings) }),
  };
}
