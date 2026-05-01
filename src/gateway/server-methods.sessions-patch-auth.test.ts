import { describe, expect, it, vi } from "vitest";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./server-methods/types.js";

const noWebchat = () => false;

function buildContext(): GatewayRequestContext {
  return {
    logGateway: {
      warn: vi.fn(),
    },
  } as unknown as GatewayRequestContext;
}

function buildClient(scopes: string[]) {
  return {
    connect: {
      role: "operator",
      scopes,
      client: {
        id: "openclaw-control-ui",
        version: "1.0.0",
        platform: "web",
        mode: "webchat",
      },
      minProtocol: 1,
      maxProtocol: 1,
    },
    connId: "conn-1",
  } satisfies Parameters<typeof handleGatewayRequest>[0]["client"];
}

async function runSessionsPatch(params: Record<string, unknown>, scopes: string[]) {
  const respond = vi.fn();
  const handlerCalls = vi.fn();
  const handler: GatewayRequestHandler = (opts) => {
    handlerCalls(opts.params);
    opts.respond(true, { ok: true }, undefined);
  };

  await handleGatewayRequest({
    req: {
      type: "req",
      id: "req-1",
      method: "sessions.patch",
      params,
    },
    respond,
    client: buildClient(scopes),
    isWebchatConnect: noWebchat,
    context: buildContext(),
    extraHandlers: {
      "sessions.patch": handler,
    },
  });

  return { respond, handlerCalls };
}

describe("sessions.patch gateway authorization", () => {
  it("allows operator.write clients to update session UI fields", async () => {
    const { respond, handlerCalls } = await runSessionsPatch(
      {
        key: "agent:main:main",
        label: "Main",
        model: "openai-codex/gpt-5.4",
        thinkingLevel: "medium",
      },
      ["operator.write"],
    );

    expect(handlerCalls).toHaveBeenCalledWith({
      key: "agent:main:main",
      label: "Main",
      model: "openai-codex/gpt-5.4",
      thinkingLevel: "medium",
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("keeps non-UI session patch fields admin-gated", async () => {
    const { respond, handlerCalls } = await runSessionsPatch(
      {
        key: "agent:main:main",
        model: "openai-codex/gpt-5.4",
        execHost: "gateway",
      },
      ["operator.write"],
    );

    expect(handlerCalls).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "missing scope: operator.admin",
      }),
    );
  });

  it("still rejects session UI patches without operator.write or operator.admin", async () => {
    const { respond, handlerCalls } = await runSessionsPatch(
      {
        key: "agent:main:main",
        model: "openai-codex/gpt-5.4",
      },
      ["operator.read"],
    );

    expect(handlerCalls).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "missing scope: operator.admin",
      }),
    );
  });
});
