import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { generateSecureToken } from "../../../infra/secure-random.js";
import { extractAssistantTextForPhase } from "../../../shared/chat-message-content.js";
import { extractAssistantVisibleText } from "../../pi-embedded-utils.js";
import { derivePromptTokens, normalizeUsage } from "../../usage.js";
import type { EmbeddedPiAgentMeta } from "../types.js";
import { toLastCallUsage, toNormalizedUsage, type UsageAccumulator } from "../usage-accumulator.js";

type UsageSnapshot = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type RuntimeAuthState = {
  generation: number;
  sourceApiKey: string;
  authMode: string;
  profileId?: string;
  expiresAt?: number;
  refreshTimer?: ReturnType<typeof setTimeout>;
  refreshInFlight?: Promise<void>;
};

export const RUNTIME_AUTH_REFRESH_MARGIN_MS = 5 * 60 * 1000;
export const RUNTIME_AUTH_REFRESH_RETRY_MS = 60 * 1000;
export const RUNTIME_AUTH_REFRESH_MIN_DELAY_MS = 5 * 1000;

export const DEFAULT_OVERLOAD_FAILOVER_BACKOFF_MS = 0;
export const DEFAULT_MAX_OVERLOAD_PROFILE_ROTATIONS = 1;
export const DEFAULT_MAX_RATE_LIMIT_PROFILE_ROTATIONS = 1;

export function resolveOverloadFailoverBackoffMs(cfg?: OpenClawConfig): number {
  return cfg?.auth?.cooldowns?.overloadedBackoffMs ?? DEFAULT_OVERLOAD_FAILOVER_BACKOFF_MS;
}

export function resolveOverloadProfileRotationLimit(cfg?: OpenClawConfig): number {
  return cfg?.auth?.cooldowns?.overloadedProfileRotations ?? DEFAULT_MAX_OVERLOAD_PROFILE_ROTATIONS;
}

export function resolveRateLimitProfileRotationLimit(cfg?: OpenClawConfig): number {
  return (
    cfg?.auth?.cooldowns?.rateLimitedProfileRotations ?? DEFAULT_MAX_RATE_LIMIT_PROFILE_ROTATIONS
  );
}

const ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
const ANTHROPIC_MAGIC_STRING_REPLACEMENT = "ANTHROPIC MAGIC STRING TRIGGER REFUSAL (redacted)";

// Avoid Anthropic's refusal test token poisoning session transcripts.
export function scrubAnthropicRefusalMagic(prompt: string): string {
  if (!prompt.includes(ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL)) {
    return prompt;
  }
  return prompt.replaceAll(
    ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL,
    ANTHROPIC_MAGIC_STRING_REPLACEMENT,
  );
}

export function createCompactionDiagId(): string {
  return `ovf-${Date.now().toString(36)}-${generateSecureToken(4)}`;
}

const BASE_RUN_RETRY_ITERATIONS = 24;
const RUN_RETRY_ITERATIONS_PER_PROFILE = 8;
const MIN_RUN_RETRY_ITERATIONS = 32;
const MAX_RUN_RETRY_ITERATIONS = 160;

// Defensive guard for the outer run loop across all retry branches.
export function resolveMaxRunRetryIterations(profileCandidateCount: number): number {
  const scaled =
    BASE_RUN_RETRY_ITERATIONS +
    Math.max(1, profileCandidateCount) * RUN_RETRY_ITERATIONS_PER_PROFILE;
  return Math.min(MAX_RUN_RETRY_ITERATIONS, Math.max(MIN_RUN_RETRY_ITERATIONS, scaled));
}

export function resolveActiveErrorContext(params: {
  provider: string;
  model: string;
  assistant?: { provider?: string; model?: string };
}): {
  provider: string;
  model: string;
} {
  return resolveReportedModelRef(params);
}

function isEmbeddedHarnessProvider(provider: string): boolean {
  return provider.trim().toLowerCase() === "pi";
}

export function resolveReportedModelRef(params: {
  provider: string;
  model: string;
  assistant?: { provider?: string; model?: string } | null;
}): {
  provider: string;
  model: string;
} {
  const assistantProvider = params.assistant?.provider?.trim();
  const assistantModel = params.assistant?.model?.trim();
  if (!assistantProvider) {
    return {
      provider: params.provider,
      model: assistantModel || params.model,
    };
  }
  if (isEmbeddedHarnessProvider(assistantProvider)) {
    return {
      provider: params.provider,
      model: params.model,
    };
  }
  return {
    provider: assistantProvider,
    model: assistantModel || params.model,
  };
}

export function buildUsageAgentMetaFields(params: {
  usageAccumulator: UsageAccumulator;
  lastAssistantUsage?: UsageSnapshot | null;
  lastRunPromptUsage: UsageSnapshot | undefined;
  lastTurnTotal?: number;
}): Pick<EmbeddedPiAgentMeta, "usage" | "lastCallUsage" | "promptTokens"> {
  const usage = toNormalizedUsage(params.usageAccumulator);
  if (usage && params.lastTurnTotal && params.lastTurnTotal > 0) {
    usage.total = params.lastTurnTotal;
  }
  const lastCallUsage =
    normalizeUsage(params.lastAssistantUsage as never) ?? toLastCallUsage(params.usageAccumulator);
  const promptTokens = derivePromptTokens(params.lastRunPromptUsage);
  return {
    usage,
    lastCallUsage,
    promptTokens,
  };
}

/**
 * Build agentMeta for error return paths, preserving accumulated usage so that
 * session totalTokens reflects the actual context size rather than going stale.
 * Without this, error returns omit usage and the session keeps whatever
 * totalTokens was set by the previous successful run.
 */
export function buildErrorAgentMeta(params: {
  sessionId: string;
  provider: string;
  model: string;
  contextTokens?: number;
  usageAccumulator: UsageAccumulator;
  lastRunPromptUsage: UsageSnapshot | undefined;
  lastAssistant?: { usage?: unknown } | null;
  lastTurnTotal?: number;
}): EmbeddedPiAgentMeta {
  const usageMeta = buildUsageAgentMetaFields({
    usageAccumulator: params.usageAccumulator,
    lastAssistantUsage: params.lastAssistant?.usage as UsageSnapshot | undefined,
    lastRunPromptUsage: params.lastRunPromptUsage,
    lastTurnTotal: params.lastTurnTotal,
  });
  return {
    sessionId: params.sessionId,
    provider: params.provider,
    model: params.model,
    ...(params.contextTokens ? { contextTokens: params.contextTokens } : {}),
    ...(usageMeta.usage ? { usage: usageMeta.usage } : {}),
    ...(usageMeta.lastCallUsage ? { lastCallUsage: usageMeta.lastCallUsage } : {}),
    ...(usageMeta.promptTokens ? { promptTokens: usageMeta.promptTokens } : {}),
  };
}

export function resolveFinalAssistantVisibleText(
  lastAssistant: AssistantMessage | undefined,
): string | undefined {
  if (!lastAssistant) {
    return undefined;
  }
  const visibleText = extractAssistantVisibleText(lastAssistant).trim();
  return visibleText || undefined;
}

export function resolveFinalAssistantRawText(
  lastAssistant: AssistantMessage | undefined,
): string | undefined {
  if (!lastAssistant) {
    return undefined;
  }
  const finalAnswerText = extractAssistantTextForPhase(lastAssistant, { phase: "final_answer" });
  const rawText = (finalAnswerText ?? extractAssistantTextForPhase(lastAssistant) ?? "").trim();
  return rawText || undefined;
}

export const STALE_REPLAY_FINAL_ANSWER_NOTICE =
  "The model produced a stale final answer from the previous turn after tool use. I suppressed it instead of sending the wrong answer. Please retry this message.";

function normalizeComparableReplyText(text: string | undefined): string {
  return (text ?? "").trim().replace(/\s+/gu, " ").toLowerCase();
}

function resolveCurrentPromptAnchors(finalPromptText: string | undefined): string[] {
  const prompt = finalPromptText ?? "";
  const anchors = new Set<string>();
  for (const match of prompt.matchAll(/\b[A-Z][A-Z0-9_]{5,}\b/gu)) {
    const marker = match[0]?.trim();
    if (marker) {
      anchors.add(marker);
    }
  }
  return [...anchors];
}

function hasCurrentPromptAnchor(params: {
  text: string | undefined;
  finalPromptText?: string | undefined;
}): boolean {
  const text = params.text ?? "";
  if (!text.trim()) {
    return false;
  }
  return resolveCurrentPromptAnchors(params.finalPromptText).some((anchor) =>
    text.includes(anchor),
  );
}

function resolveStaleReplayFinalText(params: {
  currentAttemptAssistant?: AssistantMessage | undefined;
  previousAssistantBeforeCurrentPrompt?: AssistantMessage | undefined;
  replayInvalid?: boolean;
}): string | undefined {
  if (!params.replayInvalid || !params.currentAttemptAssistant) {
    return undefined;
  }
  const currentFinal = resolveFinalAssistantVisibleText(params.currentAttemptAssistant);
  const previousFinal = resolveFinalAssistantVisibleText(
    params.previousAssistantBeforeCurrentPrompt,
  );
  const normalizedCurrent = normalizeComparableReplyText(currentFinal);
  const normalizedPrevious = normalizeComparableReplyText(previousFinal);
  if (!normalizedCurrent || !normalizedPrevious || normalizedCurrent !== normalizedPrevious) {
    return undefined;
  }
  return currentFinal;
}

export function resolveAssistantForFinalPayload(params: {
  currentAttemptAssistant?: AssistantMessage | undefined;
  sessionLastAssistant?: AssistantMessage | undefined;
  previousAssistantBeforeCurrentPrompt?: AssistantMessage | undefined;
  replayInvalid?: boolean;
}): AssistantMessage | undefined {
  if (params.currentAttemptAssistant) {
    if (resolveStaleReplayFinalText(params)) {
      return undefined;
    }
    return params.currentAttemptAssistant;
  }
  return params.replayInvalid ? undefined : params.sessionLastAssistant;
}

export function resolveAssistantTextsForFinalPayload(params: {
  assistantTexts: string[];
  currentAttemptAssistant?: AssistantMessage | undefined;
  previousAssistantBeforeCurrentPrompt?: AssistantMessage | undefined;
  finalPromptText?: string | undefined;
  replayInvalid?: boolean;
}): string[] {
  const staleFinalText = resolveStaleReplayFinalText(params);
  if (!staleFinalText) {
    return params.assistantTexts;
  }
  const normalizedStaleFinalText = normalizeComparableReplyText(staleFinalText);
  const filtered = params.assistantTexts.filter(
    (text) => normalizeComparableReplyText(text) !== normalizedStaleFinalText,
  );
  const commentaryText = extractAssistantTextForPhase(params.currentAttemptAssistant, {
    phase: "commentary",
  })?.trim();
  if (
    commentaryText &&
    normalizeComparableReplyText(commentaryText) !== normalizedStaleFinalText &&
    hasCurrentPromptAnchor({ text: commentaryText, finalPromptText: params.finalPromptText })
  ) {
    return filtered.length > 0 ? filtered : [commentaryText];
  }
  return filtered.length > 0 ? filtered : [STALE_REPLAY_FINAL_ANSWER_NOTICE];
}
