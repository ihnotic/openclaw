import {
  abortAndDrainEmbeddedPiRun,
  resolveActiveEmbeddedRunSessionId,
} from "../../agents/pi-embedded-runner/runs.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { abortChatRunsForSessionKey } from "../chat-abort.js";
import { setGatewayDedupeEntry } from "./agent-wait-dedupe.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const SUPERSEDED_AGENT_TURN_ABORT_SETTLE_MS = 15_000;

export function shouldSupersedeActiveSessionRuns(
  inputProvenance: InputProvenance | undefined,
): boolean {
  return inputProvenance?.kind !== "inter_session" && inputProvenance?.kind !== "internal_system";
}

export async function abortSupersededSessionRuns(params: {
  context: GatewayRequestHandlerOptions["context"];
  sessionKey: string;
  nextRunId: string;
}): Promise<{ ok: true; abortedRunIds: string[] } | { ok: false; error: string }> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: true, abortedRunIds: [] };
  }

  const sessionIdsToDrain = new Set<string>();
  const activeRunIds: string[] = [];
  for (const [runId, active] of params.context.chatAbortControllers) {
    if (runId === params.nextRunId || active.sessionKey !== sessionKey) {
      continue;
    }
    activeRunIds.push(runId);
    if (active.sessionId) {
      sessionIdsToDrain.add(active.sessionId);
    }
  }

  const activeEmbeddedSessionId = resolveActiveEmbeddedRunSessionId(sessionKey);
  if (activeEmbeddedSessionId) {
    sessionIdsToDrain.add(activeEmbeddedSessionId);
  }

  if (activeRunIds.length === 0 && sessionIdsToDrain.size === 0) {
    return { ok: true, abortedRunIds: [] };
  }

  const aborted = abortChatRunsForSessionKey(
    {
      chatAbortControllers: params.context.chatAbortControllers,
      chatRunBuffers: params.context.chatRunBuffers,
      chatDeltaSentAt: params.context.chatDeltaSentAt,
      chatDeltaLastBroadcastLen: params.context.chatDeltaLastBroadcastLen,
      chatAbortedRuns: params.context.chatAbortedRuns,
      removeChatRun: params.context.removeChatRun,
      agentRunSeq: params.context.agentRunSeq,
      broadcast: params.context.broadcast,
      nodeSendToSession: params.context.nodeSendToSession,
    },
    {
      sessionKey,
      stopReason: "superseded",
    },
  );

  if (aborted.aborted) {
    params.context.logGateway.info(
      `agent turn superseded active run(s): sessionKey=${sessionKey} runIds=${aborted.runIds.join(",")}`,
    );
    const endedAt = Date.now();
    for (const runId of aborted.runIds) {
      setGatewayDedupeEntry({
        dedupe: params.context.dedupe,
        key: `agent:${runId}`,
        entry: {
          ts: endedAt,
          ok: true,
          payload: {
            runId,
            status: "timeout" as const,
            stopReason: "superseded",
            endedAt,
          },
        },
      });
    }
  }

  const drainResults = await Promise.all(
    [...sessionIdsToDrain].map(async (sessionId) => ({
      sessionId,
      result: await abortAndDrainEmbeddedPiRun({
        sessionId,
        sessionKey,
        settleMs: SUPERSEDED_AGENT_TURN_ABORT_SETTLE_MS,
        reason: "superseded_agent_turn",
      }),
    })),
  );

  const failedDrain = drainResults.find(
    ({ result }) => result.aborted && !result.drained && !result.forceCleared,
  );
  if (failedDrain) {
    params.context.logGateway.warn(
      `agent turn supersede drain timed out: sessionKey=${sessionKey} sessionId=${failedDrain.sessionId}`,
    );
    return {
      ok: false,
      error: `Session ${sessionKey} is still active; try again in a moment.`,
    };
  }

  return { ok: true, abortedRunIds: aborted.runIds };
}
