import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  resolveAssistantForFinalPayload,
  resolveAssistantTextsForFinalPayload,
  resolveFinalAssistantRawText,
  resolveFinalAssistantVisibleText,
  STALE_REPLAY_FINAL_ANSWER_NOTICE,
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

  it("suppresses a replay-invalid final answer when it repeats the prior final", () => {
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
        text: "QA_PLEX current ok",
        textSignature: JSON.stringify({ v: 1, id: "current_commentary", phase: "commentary" }),
      },
      {
        type: "text",
        text: "QA_MODEL previous ok",
        textSignature: JSON.stringify({ v: 1, id: "current_final", phase: "final_answer" }),
      },
    ]);

    expect(
      resolveAssistantForFinalPayload({
        currentAttemptAssistant: currentAssistant,
        previousAssistantBeforeTurn: priorAssistant,
        replayInvalid: true,
      }),
    ).toBeUndefined();
  });
});

describe("resolveAssistantTextsForFinalPayload", () => {
  it("promotes current anchored commentary when replay-invalid final text repeats the prior answer", () => {
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
        text: "QA_PLEX_YES_123456 current ok",
        textSignature: JSON.stringify({ v: 1, id: "current_commentary", phase: "commentary" }),
      },
      {
        type: "text",
        text: "QA_MODEL previous ok",
        textSignature: JSON.stringify({ v: 1, id: "current_final", phase: "final_answer" }),
      },
    ]);

    expect(
      resolveAssistantTextsForFinalPayload({
        assistantTexts: ["QA_MODEL previous ok"],
        currentAttemptAssistant: currentAssistant,
        previousAssistantBeforeTurn: priorAssistant,
        finalPromptText: "QA_PLEX_YES_123456 answer this current prompt",
        replayInvalid: true,
      }),
    ).toEqual(["QA_PLEX_YES_123456 current ok"]);
  });

  it("emits a retry notice instead of silently dropping an unanchored stale final", () => {
    const priorAssistant = makeAssistantMessage([
      {
        type: "text",
        text: "Prior answer",
        textSignature: JSON.stringify({ v: 1, id: "prior_final", phase: "final_answer" }),
      },
    ]);
    const currentAssistant = makeAssistantMessage([
      {
        type: "text",
        text: "Working on it",
        textSignature: JSON.stringify({ v: 1, id: "current_commentary", phase: "commentary" }),
      },
      {
        type: "text",
        text: "Prior answer",
        textSignature: JSON.stringify({ v: 1, id: "current_final", phase: "final_answer" }),
      },
    ]);

    expect(
      resolveAssistantTextsForFinalPayload({
        assistantTexts: ["Prior answer"],
        currentAttemptAssistant: currentAssistant,
        previousAssistantBeforeTurn: priorAssistant,
        finalPromptText: "What is the status?",
        replayInvalid: true,
      }),
    ).toEqual([STALE_REPLAY_FINAL_ANSWER_NOTICE]);
  });
});
