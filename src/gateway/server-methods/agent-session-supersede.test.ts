import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import {
  abortSupersededSessionRuns,
  shouldSupersedeActiveSessionRuns,
} from "./agent-session-supersede.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const runMocks = vi.hoisted(() => ({
  abortAndDrainEmbeddedPiRun: vi.fn(async () => ({
    aborted: true,
    drained: true,
    forceCleared: false,
  })),
  resolveActiveEmbeddedRunSessionId: vi.fn(() => undefined as string | undefined),
}));

vi.mock("../../agents/pi-embedded-runner/runs.js", () => ({
  abortAndDrainEmbeddedPiRun: runMocks.abortAndDrainEmbeddedPiRun,
  resolveActiveEmbeddedRunSessionId: runMocks.resolveActiveEmbeddedRunSessionId,
}));

function makeContext(): GatewayRequestHandlerOptions["context"] {
  return {
    dedupe: new Map(),
    chatAbortControllers: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatDeltaLastBroadcastLen: new Map(),
    chatAbortedRuns: new Map(),
    removeChatRun: vi.fn(),
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    logGateway: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as GatewayRequestHandlerOptions["context"];
}

function makeActiveRun(sessionKey: string, sessionId: string): ChatAbortControllerEntry {
  return {
    controller: new AbortController(),
    sessionId,
    sessionKey,
    startedAtMs: 100,
    expiresAtMs: 200,
    kind: "agent",
  };
}

describe("agent session supersede", () => {
  afterEach(() => {
    runMocks.abortAndDrainEmbeddedPiRun.mockReset().mockResolvedValue({
      aborted: true,
      drained: true,
      forceCleared: false,
    });
    runMocks.resolveActiveEmbeddedRunSessionId.mockReset().mockReturnValue(undefined);
  });

  it("only supersedes direct external turns", () => {
    expect(shouldSupersedeActiveSessionRuns(undefined)).toBe(true);
    expect(shouldSupersedeActiveSessionRuns({ kind: "external_user" })).toBe(true);
    expect(shouldSupersedeActiveSessionRuns({ kind: "inter_session" })).toBe(false);
    expect(shouldSupersedeActiveSessionRuns({ kind: "internal_system" })).toBe(false);
  });

  it("aborts and drains older active runs in the same session", async () => {
    const context = makeContext();
    const active = makeActiveRun("agent:main:telegram:direct:8599953238", "session-1");
    context.chatAbortControllers.set("old-run", active);
    context.chatAbortControllers.set(
      "other-session-run",
      makeActiveRun("agent:main:main", "session-2"),
    );

    const result = await abortSupersededSessionRuns({
      context,
      sessionKey: "agent:main:telegram:direct:8599953238",
      nextRunId: "new-run",
    });

    expect(result).toEqual({ ok: true, abortedRunIds: ["old-run"] });
    expect(active.controller.signal.aborted).toBe(true);
    expect(context.chatAbortControllers.has("old-run")).toBe(false);
    expect(context.chatAbortControllers.has("other-session-run")).toBe(true);
    expect(runMocks.abortAndDrainEmbeddedPiRun).toHaveBeenCalledWith({
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:direct:8599953238",
      settleMs: 15_000,
      reason: "superseded_agent_turn",
    });
    expect(context.dedupe.get("agent:old-run")?.payload).toMatchObject({
      runId: "old-run",
      status: "timeout",
      stopReason: "superseded",
    });
  });

  it("returns unavailable when an aborted embedded run does not drain", async () => {
    runMocks.abortAndDrainEmbeddedPiRun.mockResolvedValueOnce({
      aborted: true,
      drained: false,
      forceCleared: false,
    });
    const context = makeContext();
    context.chatAbortControllers.set("old-run", makeActiveRun("agent:main:main", "session-1"));

    const result = await abortSupersededSessionRuns({
      context,
      sessionKey: "agent:main:main",
      nextRunId: "new-run",
    });

    expect(result).toEqual({
      ok: false,
      error: "Session agent:main:main is still active; try again in a moment.",
    });
    expect(context.logGateway.warn).toHaveBeenCalledWith(
      "agent turn supersede drain timed out: sessionKey=agent:main:main sessionId=session-1",
    );
  });
});
