// החוזה בין הדפדפן לשרת. הקומפוננטות מכירות רק את הטיפוסים האלה,
// ולא יודעות שום דבר על Vapi או על ספקי הקול.

export type FirstSpeaker = "bot" | "caller";

/** ההגדרות שהלקוח יכול לשנות במסך העריכה */
export interface BotSettings {
  /** מזהה הקול בקטלוג שלנו (לא ה-voiceId של הספק) */
  voiceId: string;
  firstSpeaker: FirstSpeaker;
  openingMessage: string;
  closingMessage: string;
  /**
   * ההנחיות לבוט (הודעת ה-system ב-Vapi). ריק = לא נוגעים בהנחיות הקיימות.
   * לא קיים בגרסאות ישנות, ולכן אופציונלי.
   */
  prompt?: string;
}

/** קול כפי שהדפדפן רואה אותו. פרטי הספק נשארים בשרת. */
export interface Voice {
  id: string;
  name: string;
  gender: "female" | "male";
  description: string;
  /** קובץ דוגמה מוקלט מראש. null עד שמקליטים דוגמה. */
  sampleUrl: string | null;
  tier: "standard" | "premium";
}

/** הניצול של לקוח משלם במחזור החודשי הנוכחי, לתצוגה בדף שלו */
export interface CustomerUsage {
  /** דקות שנוצלו: סכום השניות של כל השיחות, חלקי 60, בלי השארית */
  usedMinutes: number;
  limitMinutes: number;
  /** מתי המונה מתאפס (תחילת המחזור הבא), ISO */
  renewsAt: string;
}

export type PlanInfo =
  | { type: "customer"; usage: CustomerUsage | null }
  | { type: "demo"; limitSeconds: number; remainingSeconds: number; expiresAt: string };

export interface BotPageData {
  business: {
    name: string;
    /** המספר שהבוט עונה בו, לתצוגה בלבד */
    botPhoneDisplay: string | null;
  };
  settings: BotSettings;
  voices: Voice[];
  lastUpdatedAt: string | null;
  plan: PlanInfo;
  /** לאן שיחת ניסיון תתקשר, מוסתר חלקית. null אם לא הוגדר מספר. */
  testPhoneMasked: string | null;
}

export interface UpdateResult {
  settings: BotSettings;
  lastUpdatedAt: string;
}

export interface TestCallResult {
  /** המספר שאליו התקשרנו, מוסתר חלקית */
  calledNumberMasked: string;
  /** בדמו: כמה שניות נשארו לפני השיחה הזו. null אצל לקוח משלם. */
  demoRemainingSeconds: number | null;
}

export type FieldErrors = Partial<Record<keyof BotSettings, string>>;

export type ApiErrorCode =
  | "validation"
  | "unauthorized"
  | "suspended"
  | "demo_ended"
  | "busy"
  | "not_configured"
  | "vapi_error"
  | "server";

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  fieldErrors?: FieldErrors;
}
