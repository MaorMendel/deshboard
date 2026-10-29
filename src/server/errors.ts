import type { ApiErrorBody, ApiErrorCode, FieldErrors } from "@/lib/types";

const STATUS: Record<ApiErrorCode, number> = {
  validation: 400,
  unauthorized: 401,
  suspended: 403,
  demo_ended: 403,
  busy: 409,
  not_configured: 409,
  vapi_error: 502,
  server: 500,
};

export class ServiceError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly fieldErrors?: FieldErrors,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/** ממיר כל שגיאה לתשובת JSON אחידה, בלי לחשוף פרטים פנימיים לדפדפן */
export function errorResponse(err: unknown): Response {
  if (err instanceof ServiceError) {
    const body: ApiErrorBody = { code: err.code, message: err.message };
    if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
    return Response.json(body, { status: STATUS[err.code] });
  }
  console.error(err);
  const body: ApiErrorBody = { code: "server", message: "משהו השתבש בשרת. אפשר לנסות שוב בעוד רגע." };
  return Response.json(body, { status: 500 });
}

/** האם השגיאה היא הפרה של אילוץ ייחודיות מסוים ב-Postgres (עובד גם עם postgres-js וגם עם PGlite) */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const o = e as { code?: string; constraint?: string; constraint_name?: string; message?: string };
    if (o.code === "23505") {
      if (!constraint) return true;
      const name = o.constraint ?? o.constraint_name ?? "";
      if (name === constraint || (o.message ?? "").includes(constraint)) return true;
    }
  }
  return false;
}
