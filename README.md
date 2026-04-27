# @ledgermem/openai-assistants

Drop-in OpenAI Assistants API compatibility shim backed by LedgerMem. Point
your existing `openai` SDK at this handler and threads/messages persist to
LedgerMem instead of OpenAI.

## Install

```bash
npm install @ledgermem/openai-assistants @ledgermem/memory openai
```

## Quickstart (30 seconds)

```ts
import express from "express";
import { LedgerMem } from "@ledgermem/memory";
import { createAssistantsShim } from "@ledgermem/openai-assistants";

const app = express();
app.use(express.json());

const ledgermem = new LedgerMem({
  apiKey: process.env.LEDGERMEM_API_KEY!,
  workspaceId: process.env.LEDGERMEM_WORKSPACE_ID!,
});

const shim = createAssistantsShim({ ledgermem });
app.all("/v1/threads*", (req, res) => shim(req as any, res as any));

app.listen(8787);
```

Then point the OpenAI SDK at it:

```ts
import OpenAI from "openai";
const client = new OpenAI({
  apiKey: "anything",
  baseURL: "http://localhost:8787/v1",
});

const thread = await client.beta.threads.create();
await client.beta.threads.messages.create(thread.id, {
  role: "user",
  content: "Remember I prefer dark mode.",
});
const list = await client.beta.threads.messages.list(thread.id);
```

## Routes implemented

| Method | Path                              |
| ------ | --------------------------------- |
| POST   | `/v1/threads`                     |
| GET    | `/v1/threads/:id`                 |
| DELETE | `/v1/threads/:id`                 |
| POST   | `/v1/threads/:id/messages`        |
| GET    | `/v1/threads/:id/messages`        |
| GET    | `/v1/threads/:id/messages/:msgId` |

Runs and assistants live elsewhere — this shim is for thread/message storage,
which is the common migration pain point.

## License

MIT
