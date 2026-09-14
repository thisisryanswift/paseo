import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentSession,
  AgentStreamEvent,
  AgentPromptInput,
} from "./agent-sdk-types.js";
import {
  sendPromptToAgent,
  startAgentRun,
  startCreatedAgentInitialPrompt,
} from "./agent-prompt.js";
import type {
  AgentPromptHandle,
  AgentPromptCompletion,
  AgentPromptCheckpoint,
} from "./agent-prompt-handle.js";
import { createPaseoToolCatalog } from "./tools/paseo-tools.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function fixture(provider = "opencode", external = true, pilot = false) {
  const home = await mkdtemp(join(tmpdir(), "native-admission-"));
  homes.push(home);
  const logger = createTestLogger();
  const storage = new AgentStorage(join(home, "agents"), logger);
  // A local cooperation flag must not masquerade as a verified native queue capability.
  const capabilities = {
    supportsAbortableTurnAdmission: true,
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: false,
    supportsMcpServers: false,
    supportsReasoningStream: false,
    supportsToolInvocations: false,
  };
  const listeners = new Set<(event: AgentStreamEvent) => void>();
  const prompts: AgentPromptInput[] = [],
    controls: string[] = [];
  const promptWaiters = new Map<number, ReturnType<typeof deferred>>();
  let currentTurn = "native-A";
  const emit = (event: AgentStreamEvent) => {
    for (const listener of listeners) listener(event);
  };
  const session: AgentSession = {
    provider,
    id: "native-session",
    capabilities,
    run: async () => {
      throw new Error("Unexpected session.run");
    },
    startTurn: async (prompt) => {
      prompts.push(prompt);
      currentTurn = `submitted-${prompts.length}`;
      promptWaiters.get(prompts.length)?.resolve();
      return { turnId: currentTurn };
    },
    subscribe: (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    streamHistory: async function* () {},
    getRuntimeInfo: async () => ({ provider, sessionId: "native-session" }),
    getAvailableModes: async () => [],
    getCurrentMode: async () => null,
    setMode: async (mode) => {
      controls.push(`mode:${mode}`);
    },
    getPendingPermissions: () => [],
    respondToPermission: async () => {
      controls.push("permission");
    },
    describePersistence: () => ({
      provider,
      sessionId: "native-session",
      metadata: external
        ? {
            openCodeServerUrl: "http://native.test",
            ...(pilot ? { externalOpenCodePilot: true } : {}),
          }
        : {},
    }),
    interrupt: async () => {
      controls.push("interrupt");
      emit({ type: "turn_canceled", provider, turnId: currentTurn });
    },
    close: async () => {
      controls.push("detach");
    },
    tryHandleOutOfBand: (prompt) =>
      prompt === "/control"
        ? {
            run: async () => {
              controls.push("out-of-band");
            },
          }
        : null,
  };
  const client: AgentClient = {
    provider,
    capabilities,
    createSession: async () => session,
    resumeSession: async () => session,
    fetchCatalog: async () => ({ models: [], modes: [] }),
    isAvailable: async () => true,
  };
  const manager = new AgentManager({ clients: { [provider]: client }, registry: storage, logger });
  const agent = await manager.createAgent({ provider, cwd: home, model: "test/model" }, undefined, {
    workspaceId: "workspace",
  });
  function waitForLifecycle(lifecycle: "running" | "idle") {
    return new Promise<void>((resolve) => {
      const unsubscribe = manager.subscribe(
        (event) => {
          if (event.type === "agent_state" && event.agent.lifecycle === lifecycle) {
            unsubscribe();
            resolve();
          }
        },
        { agentId: agent.id, replayState: false },
      );
    });
  }
  function nextPrompt(count: number) {
    if (prompts.length >= count) return Promise.resolve();
    const waiter = deferred();
    promptWaiters.set(count, waiter);
    return waiter.promise;
  }
  return {
    manager,
    agent,
    storage,
    logger,
    prompts,
    controls,
    emit,
    waitForLifecycle,
    nextPrompt,
    startNative: async () => {
      const running = waitForLifecycle("running");
      emit({ type: "turn_started", provider, turnId: currentTurn });
      await running;
    },
    finishNative: () => emit({ type: "turn_completed", provider, turnId: currentTurn }),
    close: () => manager.closeAgent(agent.id),
  };
}

test("ordinary pilot sends reject busy state without interruption", async () => {
  const f = await fixture("opencode", true, true);
  try {
    await f.startNative();
    await expect(
      startAgentRun(f.manager, f.agent.id, "ordinary", f.logger, { replaceRunning: true }),
    ).rejects.toThrow("OpenCode is busy");
    await expect(f.manager.runAgent(f.agent.id, "scheduled ordinary")).rejects.toThrow(
      "OpenCode is busy",
    );
    await expect(f.manager.replaceAgentRun(f.agent.id, "replacement ordinary")).rejects.toThrow(
      "OpenCode is busy",
    );
    expect(() => f.manager.streamAgent(f.agent.id, "direct stream ordinary")).toThrow(
      "OpenCode is busy",
    );
    await expect(
      startCreatedAgentInitialPrompt({
        agentManager: f.manager,
        agentId: f.agent.id,
        prompt: "initial ordinary",
        logger: f.logger,
      }),
    ).rejects.toThrow("OpenCode is busy");
    expect(f.prompts).toEqual([]);
    expect(f.controls).toEqual([]);
  } finally {
    await f.close();
  }
});

test("busy pilot sends do not mutate mode; controls remain actionable", async () => {
  const f = await fixture("opencode", true, true);
  try {
    await f.startNative();
    await expect(
      sendPromptToAgent({
        agentManager: f.manager,
        agentStorage: f.storage,
        agentId: f.agent.id,
        prompt: "ordinary",
        sessionMode: "plan",
        logger: f.logger,
      }),
    ).rejects.toThrow("OpenCode is busy");
    expect(await startAgentRun(f.manager, f.agent.id, "/control", f.logger)).toEqual({
      outOfBand: true,
    });
    await f.manager.respondToPermission(f.agent.id, "permission-id", { behavior: "allow" });
    await f.manager.cancelAgentRun(f.agent.id);
    expect(f.prompts).toEqual([]);
    expect(f.controls).toEqual(["out-of-band", "permission", "interrupt"]);
  } finally {
    await f.close();
  }
});

test("legacy custom provider aliases admit ordinary external sends", async () => {
  const f = await fixture("custom-opencode");
  try {
    const dispatch = await startAgentRun(f.manager, f.agent.id, "ordinary", f.logger);
    expect(dispatch).toMatchObject({ accepted: true, outOfBand: false });
    expect(f.prompts).toEqual(["ordinary"]);
    f.finishNative();
    expect(await dispatch.followUp?.completion).toMatchObject({ status: "completed" });
    expect(f.controls).toEqual([]);
  } finally {
    await f.close();
  }
});

test.each(["opencode", "claude"] as const)(
  "managed %s ordinary sends retain existing behavior",
  async (provider) => {
    const f = await fixture(provider, false);
    try {
      await f.startNative();
      await startAgentRun(f.manager, f.agent.id, "ordinary", f.logger, { replaceRunning: true });
      await f.nextPrompt(1);
      await f.manager.waitForAgentRunStart(f.agent.id);
      expect(f.prompts).toEqual(["ordinary"]);
      expect(f.controls).toEqual(["interrupt"]);
      f.finishNative();
    } finally {
      await f.close();
    }
  },
);

test.each([false, true])(
  "shutdown prevents reserved iterator admission/publication (consumption requested before shutdown=%s)",
  async (consumeBeforeShutdown) => {
    // Managed adapters exercise the same shutdown barrier without provider-specific observation.
    const f = await fixture("opencode", false);
    const iterator = f.manager.streamAgent(f.agent.id, "must never start");
    const publications: string[] = [];
    const unsubscribe = f.manager.subscribe(
      (event) => {
        publications.push(
          event.type === "agent_state" ? `state:${event.agent.lifecycle}` : event.event.type,
        );
      },
      { agentId: f.agent.id, replayState: false },
    );
    try {
      const firstRead = consumeBeforeShutdown ? iterator.next() : null;
      f.manager.prepareForShutdown();
      await expect(firstRead ?? iterator.next()).rejects.toThrow("shutting down");
      expect(f.prompts).toEqual([]);
      expect(publications).toEqual([]);
      expect(f.manager.hasInFlightRun(f.agent.id)).toBe(false);
    } finally {
      unsubscribe();
      await iterator.return(undefined);
      await f.close();
    }
  },
);

function projectedMessage(messageId: string) {
  let resolve!: (outcome: AgentPromptCompletion) => void;
  const completion = new Promise<AgentPromptCompletion>((res) => {
    resolve = res;
  });
  const listeners = new Set<(checkpoint: AgentPromptCheckpoint) => void>();
  let last: AgentPromptCompletion | null = null;
  const handle: AgentPromptHandle = {
    messageId,
    completion,
    result: completion,
    subscribe: (listener) => {
      listeners.add(listener);
      if (last) listener(last);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    handle,
    complete: (outcome: AgentPromptCompletion) => {
      last = outcome;
      resolve(outcome);
      for (const listener of listeners) listener(outcome);
    },
  };
}

test("blocking MCP waits follow the submitted message projection rather than older native A", async () => {
  const f = await fixture();
  const dispatched = deferred(),
    message = projectedMessage("B");
  try {
    await f.startNative();
    const catalog = createPaseoToolCatalog({
      agentManager: f.manager,
      agentStorage: f.storage,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      logger: f.logger,
      dispatchPrompt: async () => {
        dispatched.resolve();
        return { outOfBand: false, queued: true, followUp: message.handle };
      },
    });
    let returned = false;
    const call = catalog
      .executeTool("send_agent_prompt", { agentId: f.agent.id, prompt: "B", background: false })
      .then((result) => {
        returned = true;
        return result;
      });
    await dispatched.promise;
    const idle = f.waitForLifecycle("idle");
    f.finishNative();
    await idle;
    expect(returned).toBe(false);
    await f.startNative();
    message.complete({ status: "completed", lastMessage: "B output" });
    expect((await call).structuredContent).toMatchObject({
      success: true,
      status: "idle",
      lastMessage: "B output",
    });
    expect(f.manager.getAgent(f.agent.id)?.lifecycle).toBe("running");
  } finally {
    await f.close();
  }
});

test("background notifications follow message B and use B's captured output", async () => {
  const f = await fixture("claude", false);
  const message = projectedMessage("B");
  try {
    await f.startNative();
    const catalog = createPaseoToolCatalog({
      agentManager: f.manager,
      agentStorage: f.storage,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      logger: f.logger,
      callerAgentId: f.agent.id,
      dispatchPrompt: async () => ({ outOfBand: false, queued: true, followUp: message.handle }),
    });
    await catalog.executeTool("send_agent_prompt", {
      agentId: f.agent.id,
      prompt: "B",
      background: true,
      notifyOnFinish: true,
    });
    const idle = f.waitForLifecycle("idle");
    f.finishNative();
    await idle;
    expect(f.prompts).toEqual([]);
    message.complete({ status: "completed", lastMessage: "B output" });
    await f.nextPrompt(1);
    await f.manager.waitForAgentRunStart(f.agent.id);
    expect(f.prompts[0]).toContain("B output");
    f.finishNative();
  } finally {
    await f.close();
  }
});
