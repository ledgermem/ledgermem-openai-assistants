import { describe, expect, it, vi, beforeEach } from "vitest";
import { createAssistantsShim, type ShimResponse } from "./shim.js";

function fakeRes() {
  let status = 0;
  let body: unknown;
  const res: ShimResponse = {
    status: (code: number) => {
      status = code;
      return res;
    },
    json: (b: unknown) => {
      body = b;
    },
  };
  return { res, get: () => ({ status, body }) };
}

describe("createAssistantsShim", () => {
  let ledgermem: any;

  beforeEach(() => {
    ledgermem = {
      add: vi.fn().mockResolvedValue({ id: "mem_1" }),
      list: vi.fn().mockResolvedValue([
        {
          id: "mem_1",
          content: "hello",
          metadata: { threadId: "thread_x", role: "user" },
        },
      ]),
      search: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
  });

  it("creates a thread and returns a thread.* envelope", async () => {
    const handler = createAssistantsShim({ ledgermem });
    const { res, get } = fakeRes();
    await handler({ method: "POST", url: "/v1/threads", body: {} }, res);
    const { status, body } = get() as any;
    expect(status).toBe(200);
    expect(body.object).toBe("thread");
    expect(body.id).toMatch(/^thread_/);
  });

  it("rejects messages on unknown thread with 404", async () => {
    const handler = createAssistantsShim({ ledgermem });
    const { res, get } = fakeRes();
    await handler(
      {
        method: "POST",
        url: "/v1/threads/thread_missing/messages",
        body: { role: "user", content: "hi" },
      },
      res,
    );
    expect((get() as any).status).toBe(404);
  });

  it("creates a message and persists to LedgerMem", async () => {
    const handler = createAssistantsShim({ ledgermem });
    // First create the thread
    const create = fakeRes();
    await handler({ method: "POST", url: "/v1/threads", body: {} }, create.res);
    const threadId = (create.get().body as any).id;

    const { res, get } = fakeRes();
    await handler(
      {
        method: "POST",
        url: `/v1/threads/${threadId}/messages`,
        body: { role: "user", content: "hello world" },
      },
      res,
    );
    expect(ledgermem.add).toHaveBeenCalledWith("hello world", {
      metadata: { threadId, role: "user" },
    });
    const body = (get() as any).body;
    expect(body.object).toBe("thread.message");
    expect(body.content[0].text.value).toBe("hello world");
  });

  it("lists messages filtered by threadId", async () => {
    const handler = createAssistantsShim({ ledgermem });
    const create = fakeRes();
    await handler({ method: "POST", url: "/v1/threads", body: {} }, create.res);
    const threadId = (create.get().body as any).id;
    ledgermem.list.mockResolvedValue([
      {
        id: "mem_1",
        content: "msg in thread",
        metadata: { threadId, role: "user" },
      },
      {
        id: "mem_2",
        content: "other thread",
        metadata: { threadId: "other", role: "user" },
      },
    ]);

    const { res, get } = fakeRes();
    await handler(
      { method: "GET", url: `/v1/threads/${threadId}/messages` },
      res,
    );
    const body = (get() as any).body;
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(1);
    expect(body.data[0].content[0].text.value).toBe("msg in thread");
  });

  it("returns 404 for unknown routes", async () => {
    const handler = createAssistantsShim({ ledgermem });
    const { res, get } = fakeRes();
    await handler({ method: "GET", url: "/v1/assistants" }, res);
    expect((get() as any).status).toBe(404);
  });
});
