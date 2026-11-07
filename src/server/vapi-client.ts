// לקוח קטן ל-API של Vapi. השמות והשדות כאן לפי ה-OpenAPI הרשמי (https://api.vapi.ai/api-json).

import type { CallCostBreakdown } from "@/db/schema";
import { config } from "./config";

export type VapiVoice = { provider: string; voiceId: string; [key: string]: unknown };

export interface VapiModelMessage {
  role: string;
  content?: string;
  [key: string]: unknown;
}

/** ה-model של assistant: ספק, מודל וההודעות (הפרומפט הוא הודעת ה-system) */
export interface VapiModel {
  provider?: string;
  model?: string;
  messages?: VapiModelMessage[];
  [key: string]: unknown;
}

export interface VapiPhoneNumber {
  id: string;
  number?: string;
  name?: string;
  provider?: string;
}

export interface VapiAssistant {
  id: string;
  name?: string;
  voice?: VapiVoice;
  model?: VapiModel;
  firstMessage?: string;
  firstMessageMode?: "assistant-speaks-first" | "assistant-speaks-first-with-model-generated-message" | "assistant-waits-for-user";
  endCallMessage?: string;
  maxDurationSeconds?: number;
}

export type VapiCallStatus =
  | "scheduled"
  | "queued"
  | "ringing"
  | "in-progress"
  | "forwarding"
  | "ended"
  | "not-found"
  | "deletion-failed";

export interface VapiCall {
  id: string;
  type?: "inboundPhoneCall" | "outboundPhoneCall" | "webCall" | "vapi.websocketCall";
  status?: VapiCallStatus;
  assistantId?: string;
  phoneNumberId?: string;
  customer?: { number?: string };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  cost?: number;
  costBreakdown?: CallCostBreakdown;
  endedReason?: string;
}

export interface AssistantFields {
  voice?: VapiVoice;
  firstMessage?: string;
  firstMessageMode?: VapiAssistant["firstMessageMode"];
  endCallMessage?: string;
  maxDurationSeconds?: number;
  /** נשלח רק כשהלקוח ערך את ההנחיות, תמיד כאובייקט מלא (ראו modelWithPrompt) */
  model?: VapiModel;
}

export interface CreateCallInput {
  assistantId: string;
  assistantOverrides?: AssistantFields;
  phoneNumberId: string;
  customer: { number: string };
  name?: string;
}

export class VapiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "VapiError";
  }
}

export function isVapiConfigured(): boolean {
  return config.vapi.privateKey().length > 0;
}

async function vapiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = config.vapi.privateKey();
  if (!key) throw new VapiError("VAPI_PRIVATE_KEY לא מוגדר", 0, null);

  let res: Response;
  try {
    res = await fetch(`${config.vapi.baseUrl()}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new VapiError(`אין חיבור ל-Vapi: ${(err as Error).message}`, 0, null);
  }

  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // התשובה לא JSON
  }
  if (!res.ok) {
    const detail = (body as { message?: unknown })?.message ?? text;
    throw new VapiError(`Vapi החזיר ${res.status}: ${JSON.stringify(detail).slice(0, 300)}`, res.status, body);
  }
  return body as T;
}

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const vapi = {
  getAssistant: (id: string) => vapiFetch<VapiAssistant>(`/assistant/${encodeURIComponent(id)}`),

  listAssistants: (limit = 1000) => vapiFetch<VapiAssistant[]>(`/assistant${query({ limit })}`),

  updateAssistant: (id: string, patch: AssistantFields) =>
    vapiFetch<VapiAssistant>(`/assistant/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  /** עדכון שדות חופשיים ב-assistant (למשל model, לעריכת הפרומפט). שולחים תמיד אובייקט שלם לכל שדה. */
  patchAssistant: (id: string, patch: Record<string, unknown>) =>
    vapiFetch<VapiAssistant>(`/assistant/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  listPhoneNumbers: () => vapiFetch<VapiPhoneNumber[]>(`/phone-number${query({ limit: 1000 })}`),

  createCall: (input: CreateCallInput) =>
    vapiFetch<VapiCall>(`/call`, { method: "POST", body: JSON.stringify(input) }),

  getCall: (id: string) => vapiFetch<VapiCall>(`/call/${encodeURIComponent(id)}`),

  listCalls: (params: { assistantId?: string; updatedAtGe?: string; createdAtLt?: string; limit?: number }) =>
    vapiFetch<VapiCall[]>(`/call${query({ limit: 1000, ...params })}`),
};
