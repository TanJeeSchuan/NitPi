/**
 * Scripted OpenAI-compatible streaming stub: one per stage. Each request
 * returns canned SSE chat-completions chunks in script order; a turn can be
 * scripted to error (HTTP 4xx/5xx).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

export interface StubToolCall {
  id: string;
  name: string;
  /** JSON string of arguments. */
  input: string;
}

export interface StubTurn {
  kind?: "turn";
  /** Plain assistant text chunks (each emitted as one delta). */
  text?: string[];
  toolCall?: StubToolCall;
  /** finish_reason of the final chunk; inferred: tool call → tool_calls, else stop. */
  finishReason?: "stop" | "tool_calls";
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface StubError {
  kind: "error";
  status: number;
  body: { error: { message: string; code?: string } };
}

export type StubScript = Array<StubTurn | StubError>;

export interface RecordedRequest {
  body: {
    model?: string;
    stream?: boolean;
    tools?: unknown;
    messages?: Array<{ role: string; content: unknown }>;
  };
}

export class ModelStub {
  private server: Server | undefined;
  private scriptIndex = 0;
  readonly requests: RecordedRequest[] = [];

  constructor(private script: StubScript, private modelId: string) {}

  /** True when every scripted step was served. */
  get exhausted(): boolean {
    return this.scriptIndex >= this.script.length;
  }

  get served(): number {
    return this.scriptIndex;
  }

  async listen(): Promise<string> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server!.address();
    if (typeof address !== "object" || !address) throw new Error("model stub failed to bind");
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.close();
    await once(this.server, "close");
    this.server = undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await this.readBody(request);
    this.requests.push({ body: JSON.parse(body) });
    const step = this.script[this.scriptIndex];
    this.scriptIndex += 1;
    if (!step) {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: { message: "model stub script exhausted" } }));
      return;
    }
    if (step.kind === "error") {
      response.statusCode = step.status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(step.body));
      return;
    }
    this.streamTurn(step, response);
  }

  private async readBody(request: IncomingMessage): Promise<string> {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    return body;
  }

  private streamTurn(turn: StubTurn, response: ServerResponse): void {
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream");
    response.setHeader("cache-control", "no-cache");
    response.setHeader("connection", "keep-alive");
    response.flushHeaders();

    const send = (payload: Record<string, unknown>): void => {
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const chunkBase = () => ({
      id: "chatcmpl-stub",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.modelId,
      choices: [{ index: 0, delta: {} }],
    });

    send({ ...chunkBase(), choices: [{ index: 0, delta: { role: "assistant" } }] });

    if (turn.toolCall) {
      send({
        ...chunkBase(),
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: turn.toolCall.id, type: "function", function: { name: turn.toolCall.name, arguments: "" } },
              ],
            },
          },
        ],
      });
      send({
        ...chunkBase(),
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: turn.toolCall.input } }] } }],
      });
    }
    for (const text of turn.text ?? []) {
      send({ ...chunkBase(), choices: [{ index: 0, delta: { content: text } }] });
    }

    const finishReason = turn.finishReason ?? (turn.toolCall ? "tool_calls" : "stop");
    const usage = turn.usage
      ? {
          prompt_tokens: turn.usage.promptTokens ?? 0,
          completion_tokens: turn.usage.completionTokens ?? 0,
          total_tokens: (turn.usage.promptTokens ?? 0) + (turn.usage.completionTokens ?? 0),
        }
      : { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 };
    // Final chunk carries usage + finish_reason.
    send({ ...chunkBase(), choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage });
    response.write("data: [DONE]\n\n");
    response.end();
  }
}
