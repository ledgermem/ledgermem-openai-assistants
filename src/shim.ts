import { LedgerMem } from "@ledgermem/memory";

/**
 * Minimal Express-style request shape — kept structural so callers can use
 * Express, Fastify (via wrapper), Hono (via shim), or a hand-rolled handler.
 */
export interface ShimRequest {
  method: string;
  /** Path including leading slash, e.g. "/v1/threads/abc/messages". */
  url: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}

export interface ShimResponse {
  status: (code: number) => ShimResponse;
  json: (body: unknown) => void;
}

export type AssistantsShimHandler = (
  req: ShimRequest,
  res: ShimResponse,
) => Promise<void>;

export interface AssistantsShimOptions {
  ledgermem: LedgerMem;
  /** Override the URL prefix. Defaults to "/v1". */
  basePath?: string;
}

interface ThreadRecord {
  id: string;
  created_at: number;
  metadata: Record<string, unknown>;
}

interface MessageRecord {
  id: string;
  object: "thread.message";
  created_at: number;
  thread_id: string;
  role: "user" | "assistant";
  content: Array<{ type: "text"; text: { value: string; annotations: [] } }>;
  metadata: Record<string, unknown>;
}

/**
 * Build a request handler that speaks the OpenAI Assistants API but stores
 * threads and messages in LedgerMem.
 *
 * Supported routes (subset that covers the common migration path):
 *   POST   /v1/threads
 *   GET    /v1/threads/:id
 *   DELETE /v1/threads/:id
 *   POST   /v1/threads/:id/messages
 *   GET    /v1/threads/:id/messages
 *   GET    /v1/threads/:id/messages/:msgId
 */
export function createAssistantsShim(
  options: AssistantsShimOptions,
): AssistantsShimHandler {
  const base = (options.basePath ?? "/v1").replace(/\/$/, "");
  const threads = new Map<string, ThreadRecord>();

  return async (req, res) => {
    const path = stripQuery(req.url);
    if (!path.startsWith(base + "/threads")) {
      sendError(res, 404, "not_found", `No route for ${req.method} ${path}`);
      return;
    }
    const tail = path.slice((base + "/threads").length);

    try {
      // POST /threads
      if (tail === "" || tail === "/") {
        if (req.method === "POST") return createThread(req, res, threads);
        return sendError(res, 405, "method_not_allowed", req.method);
      }

      const segments = tail.split("/").filter(Boolean);
      const threadId = segments[0];
      if (!threadId) {
        sendError(res, 400, "invalid_request_error", "Missing thread id");
        return;
      }

      // /threads/:id
      if (segments.length === 1) {
        if (req.method === "GET") return getThread(threadId, res, threads);
        if (req.method === "DELETE")
          return deleteThread(threadId, res, threads);
        return sendError(res, 405, "method_not_allowed", req.method);
      }

      // /threads/:id/messages[/:msgId]
      if (segments[1] === "messages") {
        if (!threads.has(threadId)) {
          sendError(res, 404, "not_found", `Thread ${threadId} not found`);
          return;
        }
        if (segments.length === 2) {
          if (req.method === "POST")
            return createMessage(threadId, req, res, options.ledgermem);
          if (req.method === "GET")
            return listMessages(threadId, res, options.ledgermem);
          return sendError(res, 405, "method_not_allowed", req.method);
        }
        if (segments.length === 3 && req.method === "GET") {
          return getMessage(threadId, segments[2]!, res, options.ledgermem);
        }
      }

      sendError(res, 404, "not_found", `No route for ${req.method} ${path}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendError(res, 500, "internal_error", msg);
    }
  };
}

function createThread(
  req: ShimRequest,
  res: ShimResponse,
  threads: Map<string, ThreadRecord>,
): void {
  const body = (req.body ?? {}) as { metadata?: Record<string, unknown> };
  const id = `thread_${randomId()}`;
  const record: ThreadRecord = {
    id,
    created_at: nowSeconds(),
    metadata: body.metadata ?? {},
  };
  threads.set(id, record);
  res.status(200).json({ id, object: "thread", ...record });
}

function getThread(
  id: string,
  res: ShimResponse,
  threads: Map<string, ThreadRecord>,
): void {
  const t = threads.get(id);
  if (!t) return sendError(res, 404, "not_found", `Thread ${id} not found`);
  res.status(200).json({ object: "thread", ...t });
}

function deleteThread(
  id: string,
  res: ShimResponse,
  threads: Map<string, ThreadRecord>,
): void {
  const existed = threads.delete(id);
  res
    .status(200)
    .json({ id, object: "thread.deleted", deleted: existed });
}

async function createMessage(
  threadId: string,
  req: ShimRequest,
  res: ShimResponse,
  client: LedgerMem,
): Promise<void> {
  const body = (req.body ?? {}) as {
    role?: "user" | "assistant";
    content?: string | Array<{ type: string; text?: { value: string } }>;
    metadata?: Record<string, unknown>;
  };
  const role = body.role ?? "user";
  const text = extractText(body.content);
  if (!text) {
    sendError(res, 400, "invalid_request_error", "content is required");
    return;
  }
  const memory = (await client.add(text, {
    metadata: { ...(body.metadata ?? {}), threadId, role },
  })) as { id?: string };
  const id = memory?.id ?? `msg_${randomId()}`;
  const message = formatMessage(id, threadId, role, text, body.metadata ?? {});
  res.status(200).json(message);
}

async function listMessages(
  threadId: string,
  res: ShimResponse,
  client: LedgerMem,
): Promise<void> {
  const all = (await client.list({ limit: 100 })) as Array<{
    id?: string;
    content?: string;
    metadata?: Record<string, unknown>;
  }>;
  const data: MessageRecord[] = all
    .filter((m) => m?.metadata?.threadId === threadId)
    .map((m) =>
      formatMessage(
        m.id ?? `msg_${randomId()}`,
        threadId,
        ((m.metadata?.role as MessageRecord["role"]) ?? "user"),
        m.content ?? "",
        m.metadata ?? {},
      ),
    );
  res.status(200).json({
    object: "list",
    data,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    has_more: false,
  });
}

async function getMessage(
  threadId: string,
  msgId: string,
  res: ShimResponse,
  client: LedgerMem,
): Promise<void> {
  const all = (await client.list({ limit: 100 })) as Array<{
    id?: string;
    content?: string;
    metadata?: Record<string, unknown>;
  }>;
  const m = all.find((x) => x.id === msgId);
  if (!m) return sendError(res, 404, "not_found", `Message ${msgId} not found`);
  res
    .status(200)
    .json(
      formatMessage(
        msgId,
        threadId,
        (m.metadata?.role as MessageRecord["role"]) ?? "user",
        m.content ?? "",
        m.metadata ?? {},
      ),
    );
}

function formatMessage(
  id: string,
  threadId: string,
  role: MessageRecord["role"],
  text: string,
  metadata: Record<string, unknown>,
): MessageRecord {
  return {
    id,
    object: "thread.message",
    created_at: nowSeconds(),
    thread_id: threadId,
    role,
    content: [{ type: "text", text: { value: text, annotations: [] } }],
    metadata,
  };
}

function extractText(
  content: string | Array<{ type: string; text?: { value: string } }> | undefined,
): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === "text" && c.text?.value)
      .map((c) => c.text!.value)
      .join("\n");
  }
  return "";
}

function sendError(
  res: ShimResponse,
  status: number,
  type: string,
  message: string,
): void {
  res.status(status).json({ error: { message, type } });
}

function stripQuery(url: string): string {
  const i = url.indexOf("?");
  return i === -1 ? url : url.slice(0, i);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 14);
}
