import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  resolveAssistantForFinalPayload,
  resolveFinalAssistantRawText,
  resolveFinalAssistantVisibleText,
} from "./helpers.js";

function makeAssistantMessage(
  content: AssistantMessage["content"],
  phase?: string,
): AssistantMessage {
  return {
    api: "responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    role: "assistant",
    content,
    timestamp: Date.now(),
    stopReason: "stop",
    ...(phase ? { phase } : {}),
  };
}

describe("resolveFinalAssistantVisibleText", () => {
  it("prefers final_answer text over commentary blocks", () => {
    const lastAssistant = makeAssistantMessage([
      {
        type: "text",
        text: "Working...",
        textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
      },
      {
        type: "text",
        text: "Section 1\nSection 2",
        textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
      },
    ]);

    expect(resolveFinalAssistantVisibleText(lastAssistant)).toBe("Section 1\nSection 2");
  });

  it("returns undefined when the final visible text is empty", () => {
    const lastAssistant = makeAssistantMessage([
      {
        type: "text",
        text: "Working...",
        textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
      },
      {
        type: "text",
        text: "   ",
        textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
      },
    ]);

    expect(resolveFinalAssistantVisibleText(lastAssistant)).toBeUndefined();
  });

  it("preserves raw final answer text without visible-text sanitization", () => {
    const lastAssistant = makeAssistantMessage([
      {
        type: "text",
        text: "<final>keep this</final>",
        textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
      },
    ]);

    expect(resolveFinalAssistantRawText(lastAssistant)).toBe("<final>keep this</final>");
  });
});

describe("resolveAssistantForFinalPayload", () => {
  it("does not fall back to a prior session assistant when replay is invalid", () => {
    const priorAssistant = makeAssistantMessage([
      {
        type: "text",
        text: "QA_MODEL previous ok",
        textSignature: JSON.stringify({ v: 1, id: "prior_final", phase: "final_answer" }),
      },
    ]);

    expect(
      resolveAssistantForFinalPayload({
        sessionLastAssistant: priorAssistant,
        replayInvalid: true,
      }),
    ).toBeUndefined();
  });

  it("uses the current attempt assistant even when replay is invalid", () => {
    const priorAssistant = makeAssistantMessage([
      {
        type: "text",
        text: "QA_MODEL previous ok",
        textSignature: JSON.stringify({ v: 1, id: "prior_final", phase: "final_answer" }),
      },
    ]);
    const currentAssistant = makeAssistantMessage([
      {
        type: "text",
        text: "QA_PLEX_YES current ok",
        textSignature: JSON.stringify({ v: 1, id: "current_final", phase: "final_answer" }),
      },
    ]);

    expect(
      resolveAssistantForFinalPayload({
        currentAttemptAssistant: currentAssistant,
        sessionLastAssistant: priorAssistant,
        replayInvalid: true,
      }),
    ).toBe(currentAssistant);
  });
});
