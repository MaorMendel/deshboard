// שרת Vapi מדומה לבדיקות. מתנהג כמו ה-API האמיתי בנקודות שהמערכת משתמשת בהן,
// ושומר את כל הבקשות כדי שהבדיקות יוכלו לוודא מה נשלח.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { VapiAssistant, VapiCall, VapiPhoneNumber } from "../src/server/vapi-client";

export interface MockVapi {
  url: string;
  requests: { method: string; path: string; body: unknown }[];
  assistants: Map<string, VapiAssistant>;
  phoneNumbers: Map<string, VapiPhoneNumber>;
  calls: Map<string, VapiCall>;
  /** שיחות "אמיתיות" שיחזרו ב-GET /call לפי assistant */
  failNext: { method: string; path: RegExp; status: number } | null;
  close(): Promise<void>;
}

export interface MockOptions {
  port?: number;
  /** לסביבה מקומית: שיחות שנוצרות "מתחילות" אחרי 3 שניות ו"מסתיימות" אחרי הזמן הזה */
  autoEndCallsAfterMs?: number;
}

export async function startMockVapi(key: string, options: MockOptions = {}): Promise<MockVapi> {
  const state: Omit<MockVapi, "url" | "close"> = {
    requests: [],
    assistants: new Map(),
    phoneNumbers: new Map(),
    calls: new Map(),
    failNext: null,
  };
  let callCounter = 0;

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url ?? "/", "http://mock");
    const method = req.method ?? "GET";
    state.requests.push({ method, path: url.pathname + url.search, body });

    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };

    if (req.headers.authorization !== `Bearer ${key}`) return send(401, { message: "Invalid Key" });
    if (state.failNext && state.failNext.method === method && state.failNext.path.test(url.pathname)) {
      const { status } = state.failNext;
      state.failNext = null;
      return send(status, { message: "mock failure" });
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "assistant") {
      if (method === "GET" && parts.length === 1) return send(200, [...state.assistants.values()]);
      const a = state.assistants.get(parts[1]);
      if (!a) return send(404, { message: "Couldn't Get Assistant. `assistant` Not Found." });
      if (method === "GET") return send(200, a);
      if (method === "PATCH") {
        const updated = { ...a, ...body };
        state.assistants.set(a.id, updated);
        return send(200, updated);
      }
    }

    if (parts[0] === "phone-number" && method === "GET") {
      return send(200, [...state.phoneNumbers.values()]);
    }

    if (parts[0] === "call") {
      if (method === "POST" && parts.length === 1) {
        if (!state.assistants.has(body.assistantId)) return send(400, { message: "assistant not found" });
        const now = new Date().toISOString();
        const call: VapiCall = {
          id: `call_${++callCounter}`,
          type: "outboundPhoneCall",
          status: "queued",
          assistantId: body.assistantId,
          phoneNumberId: body.phoneNumberId,
          customer: body.customer,
          createdAt: now,
          updatedAt: now,
        };
        state.calls.set(call.id, call);
        if (options.autoEndCallsAfterMs) {
          const id = call.id;
          setTimeout(() => {
            const c = state.calls.get(id);
            if (c) state.calls.set(id, { ...c, status: "in-progress", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
          }, 3000);
          setTimeout(() => {
            const c = state.calls.get(id);
            if (c) state.calls.set(id, { ...c, status: "ended", endedAt: new Date().toISOString(), cost: 0.05, endedReason: "customer-ended-call", updatedAt: new Date().toISOString() });
          }, 3000 + options.autoEndCallsAfterMs);
        }
        return send(201, call);
      }
      if (method === "GET" && parts.length === 2) {
        const c = state.calls.get(parts[1]);
        return c ? send(200, c) : send(404, { message: "not found" });
      }
      if (method === "GET" && parts.length === 1) {
        const assistantId = url.searchParams.get("assistantId");
        const updatedAtGe = url.searchParams.get("updatedAtGe");
        const list = [...state.calls.values()].filter(
          (c) => (!assistantId || c.assistantId === assistantId) && (!updatedAtGe || c.updatedAt >= updatedAtGe),
        );
        return send(200, list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      }
    }

    send(404, { message: `mock: no route for ${method} ${url.pathname}` });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }) as MockVapi;
}

/** מסמן שיחה כמסתיימת אחרי מספר שניות */
export function endCall(mock: MockVapi, id: string, seconds: number, cost = 0.1) {
  const c = mock.calls.get(id);
  if (!c) throw new Error(`no call ${id}`);
  const start = new Date(Date.now() - seconds * 1000 - 5000);
  mock.calls.set(id, {
    ...c,
    status: "ended",
    startedAt: start.toISOString(),
    endedAt: new Date(start.getTime() + seconds * 1000).toISOString(),
    cost,
    endedReason: "customer-ended-call",
    updatedAt: new Date().toISOString(),
  });
}
