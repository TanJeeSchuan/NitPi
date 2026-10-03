/**
 * Bridge-level unit check: the provider bridge streams pi-ai events from an
 * OpenAI-compatible endpoint, translating text, tool calls, finish reason and
 * usage. Kept small; the full pipeline lives in the scenario test.
 */
import { describe, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { createBridgedProvider } from "../../src/pi-bridge/provider-bridge.js";
import { ModelStub } from "../fixtures/model-stub.js";

describe("provider bridge over an OpenAI-compatible stub", () => {
  it("translates text deltas, tool calls, finish reason and usage", async () => {
    const stub = new ModelStub(
      [
        { toolCall: { id: "call-9", name: "read", input: JSON.stringify({ path: "src/x.ts" }) } },
        { text: ["all done"], finishReason: "stop", usage: { promptTokens: 11, completionTokens: 7 } },
      ],
      "unit-model",
    );
    const base = await stub.listen();
    try {
      const models = createModels();
      models.setProvider(
        createBridgedProvider({ stage: "unit", baseUrl: `${base}/v1`, modelId: "unit-model", apiKey: "k" }),
      );
      const model = models.getModel("nitpi-unit", "unit-model");
      expect(model).toBeDefined();
      const baseMessages = [
        { role: "user", content: "read the file", timestamp: Date.now() },
      ] as const;

      // Turn 1: tool call.
      const first = models.streamSimple(model!, { messages: [...baseMessages] });
      for await (const event of first) void event;
      const turn1 = await first.result();
      expect(turn1.stopReason).toBe("toolUse");
      const toolCall = turn1.content.find((c) => c.type === "toolCall");
      expect(toolCall && toolCall.type === "toolCall" ? toolCall.name : undefined).toBe("read");
      expect(toolCall && toolCall.type === "toolCall" ? toolCall.arguments : undefined).toEqual({ path: "src/x.ts" });
      expect(turn1.usage.input).toBe(12);

      // Turn 2: final text with usage translated from the final chunk.
      const second = models.streamSimple(model!, {
        messages: [
          ...baseMessages,
          {
            role: "assistant",
            content: turn1.content.map((c) =>
              c.type === "toolCall"
                ? { type: "tool-call", toolCallId: c.id, toolName: c.name, input: c.arguments }
                : c,
            ),
            timestamp: Date.now(),
          },
          {
            role: "toolResult",
            toolCallId: "call-9",
            toolName: "read",
            content: [{ type: "text", text: "file body" }],
            isError: false,
            timestamp: Date.now(),
          },
        ] as never,
      });
      for await (const event of second) void event;
      const turn2 = await second.result();
      expect(turn2.stopReason).toBe("stop");
      expect(turn2.usage.output).toBe(7);
      expect(turn2.usage.input).toBe(11);
      const text = turn2.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      expect(text).toBe("all done");
      expect(stub.exhausted).toBe(true);
    } finally {
      await stub.close();
    }
  });

  it("fails explicitly when the endpoint rejects tool-bearing requests; no fallback", async () => {
    const stub = new ModelStub(
      [{ kind: "error", status: 400, body: { error: { message: "tools are not supported", code: "invalid_request_error" } } }],
      "unit-model",
    );
    const base = await stub.listen();
    try {
      const models = createModels();
      models.setProvider(
        createBridgedProvider({ stage: "unit", baseUrl: `${base}/v1`, modelId: "unit-model", apiKey: "k" }),
      );
      const model = models.getModel("nitpi-unit", "unit-model")!;
      const stream = models.streamSimple(model, {
        messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
      });
      const final = await stream.result();
      expect(final.stopReason).toBe("error");
      expect(final.errorMessage).toContain("tools are not supported");
      expect(stub.served).toBe(1); // one request, no fallback retries
    } finally {
      await stub.close();
    }
  });
});
