// סגנון השיחה שהלקוח בוחר: קצב מענה, קצב דיבור, עוצמה ורעשי רקע.
// הלקוח בוחר רק מתוך האפשרויות כאן. המספרים שנשלחים ל-Vapi נקבעים בשרת בלבד,
// כך שבקשה מזויפת לא יכולה לשלוח ערכים משלה (src/server/conversation-style.ts).

export type ResponseStyle = "fast" | "patient";
export type BackgroundSound = "office" | "off";
/** דרגה: 0 = כמו שהקול מוגדר בקטלוג, שלילי = פחות, חיובי = יותר */
export type Step = -2 | -1 | 0 | 1 | 2;

export const STEPS: readonly Step[] = [-2, -1, 0, 1, 2];

export const RESPONSE_STYLES: Record<ResponseStyle, { title: string; description: string }> = {
  fast: {
    title: "מענה מהיר וזורם",
    description: "הבוט עונה מיד כשהמתקשר מסיים. מתאים למכירות, תיאום פגישות ושאלות קצרות.",
  },
  patient: {
    title: "מענה סבלני ומושקע",
    description: "הבוט מחכה שהמתקשר יסיים לגמרי. מתאים לתמיכה טכנית, ייעוץ ואיסוף פרטים מורכבים.",
  },
};

export const SPEECH_RATE_LABELS: Record<Step, string> = {
  [-2]: "איטי מאוד",
  [-1]: "איטי",
  0: "רגיל",
  1: "מהיר",
  2: "מהיר מאוד",
};

export const VOLUME_LABELS: Record<Step, string> = {
  [-2]: "שקט מאוד",
  [-1]: "שקט",
  0: "רגיל",
  1: "חזק",
  2: "חזק מאוד",
};

export const BACKGROUND_LABELS: Record<BackgroundSound, string> = {
  office: "רעשי משרד",
  off: "בלי רעשים",
};

const STYLE_KEYS = ["responseStyle", "speechRate", "volume", "backgroundSound"] as const;
export type StyleKey = (typeof STYLE_KEYS)[number];

/**
 * אילו מאפשרויות סגנון השיחה פתוחות ללקוח. האדמין מחליט לכל לקוח, וברירת המחדל: הכול סגור.
 * אפשרות סגורה לא מופיעה בדף, והשרת מתעלם ממנה גם אם היא נשלחת.
 */
export type CustomerFeatures = Record<StyleKey, boolean>;

export const NO_FEATURES: CustomerFeatures = { responseStyle: false, speechRate: false, volume: false, backgroundSound: false };

export const FEATURE_LABELS: Record<StyleKey, string> = {
  responseStyle: "קצב מענה (מהיר או סבלני)",
  speechRate: "קצב דיבור",
  volume: "עוצמת קול",
  backgroundSound: "רעשי רקע",
};

export const FEATURE_KEYS: readonly StyleKey[] = STYLE_KEYS;

/** מוריד מההגדרות את מה שסגור ללקוח, כך שלא יגיע ל-Vapi ולא יישמר בגרסה */
export function withoutClosed<T extends Partial<Record<StyleKey, unknown>>>(settings: T, features: CustomerFeatures): T {
  const out = { ...settings };
  for (const k of STYLE_KEYS) if (!features[k]) delete out[k];
  return out;
}

/**
 * גרסה ישנה שלא שמרה את סגנון השיחה: לוקחים את מה שיש עכשיו לשדות שחסרים בה,
 * כדי שחזרה אליה לא תאפס קצב דיבור או עוצמה שהלקוח בחר מאז.
 */
export function withCurrentStyle<T extends Partial<Record<(typeof STYLE_KEYS)[number], unknown>>>(
  version: T,
  current: Partial<Record<(typeof STYLE_KEYS)[number], unknown>> | null,
): T {
  if (!current) return version;
  const carried = Object.fromEntries(
    STYLE_KEYS.filter((k) => version[k] === undefined && current[k] !== undefined).map((k) => [k, current[k]]),
  );
  return { ...version, ...carried };
}

export function isResponseStyle(v: unknown): v is ResponseStyle {
  return v === "fast" || v === "patient";
}

export function isBackgroundSound(v: unknown): v is BackgroundSound {
  return v === "office" || v === "off";
}

export function isStep(v: unknown): v is Step {
  return typeof v === "number" && (STEPS as readonly number[]).includes(v);
}
