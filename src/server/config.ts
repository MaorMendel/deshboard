// כל משתני הסביבה שהשרת קורא, במקום אחד. קוראים אותם בזמן שימוש ולא בזמן טעינה,
// כדי ש-build לא ידרוש אותם ושבדיקות יוכלו לשנות אותם.

export const config = {
  appUrl: () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),

  vapi: {
    baseUrl: () => (process.env.VAPI_BASE_URL ?? "https://api.vapi.ai").replace(/\/$/, ""),
    /** המפתח הפרטי של Vapi. רק בשרת. */
    privateKey: () => process.env.VAPI_PRIVATE_KEY ?? "",
    /** assistant משותף שעליו רצים כל הדמואים */
    demoAssistantId: () => process.env.VAPI_DEMO_ASSISTANT_ID ?? "",
    /** המספר שממנו יוצאות שיחות ניסיון של דמואים, ושל לקוחות שאין להם מספר משלהם */
    testPhoneNumberId: () => process.env.VAPI_TEST_PHONE_NUMBER_ID ?? "",
  },

  /** ל-npm run voices:samples בלבד. מייצר את דוגמאות השמע של הקולות. */
  cartesiaApiKey: () => process.env.CARTESIA_API_KEY ?? "",

  /** הסיסמה של פאנל הניהול (/admin). לפחות 8 תווים. בלעדיה הפאנל כבוי. */
  adminPassword: () => process.env.ADMIN_PASSWORD ?? "",

  /** סוד משותף ל-API הפנימי (חישוב דקות וסנכרון שיחות) */
  internalApiSecret: () => process.env.INTERNAL_API_SECRET ?? "",
};
