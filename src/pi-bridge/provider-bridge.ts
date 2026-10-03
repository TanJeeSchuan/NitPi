/**
 * Provider bridge: one Pi provider integration built on AI SDK `streamText`
 * with `@ai-sdk/openai-compatible`.
 *
 * It implements pi-ai's `ProviderStreams` contract (both `stream` and
 * `streamSimple`) and translates incremental text, thinking, tool calls,
 * finish reason, usage, abort and errors into pi-ai's
 * `AssistantMessageEventStream`. Pi keeps the agent and tool loop; there is no
 * second AI SDK agent loop here.
 *
 * A stage configures its own base URL, model ID, API key and provider options.
 * An endpoint without streaming or tool-call support fails with an explicit
 * configuration error. There is no fallback model.
 *
 * Wire shapes verified against the installed SDKs (ai@7, @ai-sdk/openai-
 * compatible@3, @earendil-works/pi-ai@1.0.0):
 * - pi-ai events end with `done` `{type:"done", reason, message}` or `error`
 *   `{type:"error", reason, error}` followed by stream end.
 * - streamText's fullStream parts: text-start/delta/end (id, text),
 *   reasoning-start/delta/end, tool-input-start/delta/end, tool-call
 *   (toolCallId, toolName, input), finish (finishReason, totalUsage), abort,
 *   error.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Provider,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StopReason,
  type Tool,
  type TranscriptContext,
  type ThinkingContent,
  type ToolCall,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { streamText } from "ai";
import { formatProviderError, normalizeProviderError } from "@earendil-works/pi-ai/utils/error-body";
import type { JsonObject } from "@earendil-works/pi-ai";

/** Per-stage wiring for one OpenAI-compatible endpoint. */
export interface StageConfig {
  /** Stage name reported in errors, e.g. `primary` or `re-review`. */
  readonly stage: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKey: string;
  /** Provider options passed through to the AI SDK request. */
  readonly providerOptions?: Record<string, unknown>;
}

/** Configuration error: explicit, before or during the stage; no fallback. */
export class ProviderConfigError extends Error {
  readonly stage: string;
  constructor(stage: string, message: string) {
    super(message);
    this.name = "ProviderConfigError";
    this.stage = stage;
  }
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function emptyMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

/** pi thinking level → OpenAI-compatible `reasoning_effort` string. */
function reasoningEffort(level: ModelThinkingLevel | undefined): string | undefined {
  if (!level || level === "off") return undefined;
  const map: Record<string, string> = {
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "high",
    max: "high",
  };
  return map[level];
}

/**
 * One `Provider` over the bridge for the given stage. The provider is
 * registered under provider id `nitpi-<stage>`; its single model is the
 * stage's configured model id.
 */
export function createBridgedProvider(config: StageConfig): Provider {
  const stage = config.stage;
  if (!/^https?:\/\//.test(config.baseUrl)) {
    throw new ProviderConfigError(stage, `baseUrl for ${stage} must be an absolute http(s) URL`);
  }
  if (!config.modelId) {
    throw new ProviderConfigError(stage, `modelId for ${stage} is required`);
  }

  const model: Model<Api> = {
    id: config.modelId,
    name: config.modelId,
    // The bridge speaks OpenAI-compatible chat completions over AI SDK.
    api: "nitpi-openai-compatible" as Api,
    provider: `nitpi-${stage}`,
    baseUrl: config.baseUrl,
    input: ["text"],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
    headers: {},
  };

  const languageModel = createOpenAICompatible({
    name: stage,
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    includeUsage: true,
  }).chatModel(config.modelId);

  const streams: ProviderStreams = {
    stream: (_model, context, options) => bridge(languageModel, config, model, context, options?.signal, undefined),
    streamSimple: (_model, context, options) =>
      bridge(languageModel, config, model, context, options?.signal, options),
  };

  const provider: Provider = {
    id: `nitpi-${stage}`,
    name: `nitpi-${stage}`,
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: `${stage} API key`,
        resolve: async () => ({ auth: { apiKey: config.apiKey }, source: "workflow secret" }),
      },
    },
    getModels: () => [model],
    ...streams,
  } as never;
  return provider;
}

/** Map an AI SDK finish reason onto pi-ai's StopReason. */
export function toFinishReason(
  unified: string,
  message: AssistantMessage,
): StopReason {
  switch (unified) {
    case "tool-calls":
      return "toolUse";
    case "length":
      return "length";
    case "error":
      return "error";
    case "stop":
    case "other":
    case "content-filter":
    default:
      return message.content.some((b) => b.type === "toolCall") ? "toolUse" : "stop";
  }
}

/** Translate LanguageModelUsage (ai@7) into pi-ai Usage. */
export function toUsage(
  usage: {
    inputTokens?: number | undefined;
    inputTokenDetails?: { noCacheTokens?: number | undefined; cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined };
    outputTokens?: number | undefined;
    reasoningTokens?: number | undefined;
    totalTokens?: number | undefined;
  } | undefined,
): AssistantMessage["usage"] {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  const cacheRead = usage?.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: usage?.totalTokens ?? input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Translate one AI SDK streamText run into a pi-ai `AssistantMessageEventStream`.
 * Both `stream` and `streamSimple` share this path; `streamSimple` adds the
 * provider-neutral tool choice and reasoning level.
 */
function bridge(
  languageModel: Parameters<typeof streamText>[0]["model"],
  config: StageConfig,
  piModel: Model<Api>,
  context: TranscriptContext,
  signal: AbortSignal | undefined,
  simple: SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const message = emptyMessage(piModel);

    try {
      const tools = activeToolsFromContext(context);
      const { system, messages } = splitSystemPrompt(toAiMessages(context.messages));
      const result = streamText({
        model: languageModel,
        ...(system ? { system } : {}),
        messages,
        ...(Object.keys(tools).length > 0 ? { tools: tools as never } : {}),
        abortSignal: signal,
        maxRetries: 0,
        ...(config.providerOptions
          ? { providerOptions: { [config.stage]: config.providerOptions } as never }
          : {}),
        ...(simple?.toolChoice ? { toolChoice: (simple.toolChoice === "none" ? "none" : "auto") as never } : {}),
        ...(reasoningEffort(simple?.reasoning) ? { reasoning: reasoningEffort(simple?.reasoning) as never } : {}),
      });

      stream.push({ type: "start", partial: message });

      // AI SDK block ids → pi contentIndex positions.
      const indexByBlockId = new Map<string, number>();
      const toolBuffers = new Map<string, { contentIndex: number; id: string; name: string; input: string }>();
      let aborted = false;

      for await (const part of result.fullStream) {
        switch (part.type) {
          case "start":
          case "start-step":
          case "finish-step":
          case "raw":
          case "source":
          case "custom":
            break;
          case "reasoning-start": {
            const thinking: ThinkingContent = { type: "thinking", thinking: "" };
            message.content.push(thinking);
            const contentIndex = message.content.length - 1;
            indexByBlockId.set(part.id, contentIndex);
            stream.push({ type: "thinking_start", contentIndex, partial: message });
            break;
          }
          case "reasoning-delta": {
            const contentIndex = indexByBlockId.get(part.id) ?? message.content.length - 1;
            const block = message.content[contentIndex];
            if (block && block.type === "thinking") block.thinking += part.text;
            stream.push({ type: "thinking_delta", contentIndex, delta: part.text, partial: message });
            break;
          }
          case "reasoning-end": {
            const contentIndex = indexByBlockId.get(part.id) ?? message.content.length - 1;
            const block = message.content[contentIndex];
            const content = block && block.type === "thinking" ? block.thinking : "";
            stream.push({ type: "thinking_end", contentIndex, content, partial: message });
            break;
          }
          case "text-start": {
            message.content.push({ type: "text", text: "" });
            const contentIndex = message.content.length - 1;
            indexByBlockId.set(part.id, contentIndex);
            stream.push({ type: "text_start", contentIndex, partial: message });
            break;
          }
          case "text-delta": {
            const contentIndex = indexByBlockId.get(part.id) ?? message.content.length - 1;
            const block = message.content[contentIndex];
            if (block && block.type === "text") block.text += part.text;
            stream.push({ type: "text_delta", contentIndex, delta: part.text, partial: message });
            break;
          }
          case "text-end": {
            const contentIndex = indexByBlockId.get(part.id) ?? message.content.length - 1;
            const block = message.content[contentIndex];
            const content = block && block.type === "text" ? block.text : "";
            stream.push({ type: "text_end", contentIndex, content, partial: message });
            break;
          }
          case "tool-input-start": {
            message.content.push({ type: "toolCall", id: part.id, name: part.toolName, arguments: {} });
            const contentIndex = message.content.length - 1;
            toolBuffers.set(part.id, { contentIndex, id: part.id, name: part.toolName, input: "" });
            stream.push({ type: "toolcall_start", contentIndex, partial: message });
            break;
          }
          case "tool-input-delta": {
            const buffer = toolBuffers.get(part.id);
            if (buffer) {
              buffer.input += part.delta;
              stream.push({ type: "toolcall_delta", contentIndex: buffer.contentIndex, delta: part.delta, partial: message });
            }
            break;
          }
          case "tool-input-end": {
            const buffer = toolBuffers.get(part.id);
            if (buffer) {
              const plan = message.content[buffer.contentIndex];
              if (plan && plan.type === "toolCall") {
                plan.arguments = safeParse(buffer.input);
              }
              stream.push({
                type: "toolcall_end",
                contentIndex: buffer.contentIndex,
                toolCall: { type: "toolCall", id: buffer.id, name: buffer.name, arguments: safeParse(buffer.input) },
                partial: message,
              });
              toolBuffers.delete(part.id);
            }
            break;
          }
          case "tool-call": {
            // Complete tool call: update the buffered plan in place; when the
            // provider skipped incremental input, create it here instead.
            let buffer = toolBuffers.get(part.toolCallId);
            if (!buffer) {
              const existing = message.content.findIndex(
                (b) => b.type === "toolCall" && b.id === part.toolCallId,
              );
              if (existing >= 0) {
                buffer = { contentIndex: existing, id: part.toolCallId, name: part.toolName, input: "" };
                toolBuffers.set(part.toolCallId, buffer);
              } else {
                message.content.push({ type: "toolCall", id: part.toolCallId, name: part.toolName, arguments: {} });
                const contentIndex = message.content.length - 1;
                buffer = { contentIndex, id: part.toolCallId, name: part.toolName, input: "" };
                toolBuffers.set(part.toolCallId, buffer);
                stream.push({ type: "toolcall_start", contentIndex, partial: message });
              }
            }
            const inputText = typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {});
            const plan = message.content[buffer.contentIndex];
            if (plan && plan.type === "toolCall") {
              plan.id = part.toolCallId;
              plan.name = part.toolName;
              plan.arguments = safeParse(inputText);
            }
            stream.push({
              type: "toolcall_end",
              contentIndex: buffer.contentIndex,
              toolCall: { type: "toolCall", id: part.toolCallId, name: part.toolName, arguments: safeParse(inputText) },
              partial: message,
            });
            toolBuffers.delete(part.toolCallId);
            break;
          }
          case "finish": {
            message.stopReason = toFinishReason(part.finishReason, message);
            message.usage = toUsage(part.totalUsage);
            stream.push({ type: "done", reason: message.stopReason as never, message });
            stream.end();
            return;
          }
          case "abort": {
            aborted = true;
            break;
          }
          case "error": {
            throw part.error instanceof Error ? part.error : new Error(JSON.stringify(part.error));
          }
          default:
            break;
        }
      }

      // Stream ended without a finish part.
      message.stopReason = signal?.aborted || aborted
        ? "aborted"
        : message.content.some((b) => b.type === "toolCall")
          ? "toolUse"
          : "stop";
      if (message.stopReason === "aborted") message.errorMessage = "Request was aborted";
      stream.push({ type: "done", reason: message.stopReason as never, message });
      stream.end();
    } catch (error) {
      if (signal?.aborted) {
        message.stopReason = "aborted";
        message.errorMessage = "Request was aborted";
      } else {
        message.stopReason = "error";
        // Mirror pi's provider adapters: normalize SDK error fields so the
        // surfaced reason carries the HTTP status and body.
        message.errorMessage = formatProviderError(normalizeProviderError(error), config.stage);
        if (isContextOverflow(message.errorMessage)) {
          message.errorMessage = `context window exceeded: ${message.errorMessage}`;
        }
      }
      stream.push({ type: "error", reason: message.stopReason as never, error: message });
      stream.end();
    }
  })();
  return stream;
}

interface ActiveTool {
  name: string;
  description: string;
  parameters: unknown;
}

/**
 * pi-ai folds the active tool set into the leading system message's `tools`
 * array (SystemMessage.toolsAdded/Removed replay). The bridge only needs the
 * declarations for the current request.
 */
function activeToolsFromContext(context: TranscriptContext): Record<string, unknown> {
  const tools: Record<string, unknown> = {};
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    const sys = message as unknown as {
      tools?: ActiveTool[];
      toolsAdded?: ActiveTool[];
      toolsRemoved?: string[];
    };
    if (Array.isArray(sys.toolsAdded)) {
      for (const tool of sys.toolsAdded) tools[tool.name] = tool;
    } else if (Array.isArray(sys.tools)) {
      for (const tool of sys.tools) tools[tool.name] = tool;
    }
    if (Array.isArray(sys.toolsRemoved)) {
      for (const name of sys.toolsRemoved) delete tools[name];
    }
  }
  // Declaration-only tool set: no `execute` — the AI SDK surfaces the calls as
  // stream parts and Pi's tool loop does the execution.
  const toolSet: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const t = tool as Tool;
    toolSet[name] = {
      description: t.description,
      inputSchema: t.parameters,
    };
  }
  return toolSet;
}

/** pi transcript → AI SDK model messages (system/user/assistant/tool). */
type StreamTextArgs = Parameters<typeof streamText>[0];
type AiMessage = NonNullable<StreamTextArgs["messages"]>[number];
function toAiMessages(messages: TranscriptContext["messages"]): AiMessage[] {
  const out: AiMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      const sys = m as unknown as {
        content: string | Array<{ type: string; text?: string }>;
        sections?: Record<string, string | null>;
      };
      const base = typeof sys.content === "string" ? sys.content : (sys.content ?? []).map((c) => c.text ?? "").join("");
      const sections = Object.entries(sys.sections ?? {})
        .map(([k, v]) => (v === null ? "" : `<${k}>\n${v}\n</${k}>`))
        .join("\n\n");
      out.push({ role: "system", content: [base, sections].filter(Boolean).join("\n\n") });
      continue;
    }
    if (m.role === "user") {
      const user = m as unknown as { content: string | Array<{ type: string; text?: string }> };
      out.push({
        role: "user",
        content:
          typeof user.content === "string"
            ? user.content
            : user.content.map((c) => c.text ?? "").join(""),
      });
      continue;
    }
    if (m.role === "assistant") {
      const a = m as AssistantMessage;
      const parts: Array<Record<string, unknown>> = [];
      for (const c of a.content) {
        if (c.type === "text") parts.push({ type: "text", text: c.text });
        else if (c.type === "thinking") parts.push({ type: "reasoning", text: c.thinking });
        else if (c.type === "toolCall")
          parts.push({ type: "tool-call", toolCallId: c.id, toolName: c.name, input: c.arguments });
      }
      out.push({ role: "assistant", content: parts } as never);
      continue;
    }
    if (m.role === "toolResult") {
      const t = m as unknown as {
        toolCallId: string;
        toolName: string;
        content: Array<{ type: string; text?: string }>;
        isError: boolean;
      };
      // AI SDK tool-role message: array of tool-result parts.
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: t.toolCallId,
            toolName: t.toolName,
            output: { type: "text", value: t.content.map((c) => c.text ?? "").join("") },
          },
        ],
      } as never);
      continue;
    }
  }
  return out;
}

/**
 * streamText rejects system roles inside `messages`; the leading system
 * message becomes the `system` option and mid-transcript system messages
 * (prompt-section deltas) fold into it as trailing instructions.
 */
function splitSystemPrompt(list: AiMessage[]): { system?: string; messages: AiMessage[] } {
  const systemParts: string[] = [];
  const rest: AiMessage[] = [];
  for (const m of list) {
    if ((m as { role?: string }).role === "system") {
      systemParts.push(String((m as { content?: unknown }).content ?? ""));
      continue;
    }
    rest.push(m);
  }
  const system = systemParts.filter(Boolean).join("\n\n");
  return system ? { system, messages: rest } : { messages: rest };
}

function safeParse(input: string | undefined): JsonObject {
  if (!input) return {};
  try {
    const v: unknown = JSON.parse(input);
    return (typeof v === "object" && v !== null ? v : { value: v }) as JsonObject;
  } catch {
    return { raw: input } as JsonObject;
  }
}

export function isContextOverflow(text: string): boolean {
  return /context (window|length)|too many tokens|maximum context|token limit/i.test(text);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
