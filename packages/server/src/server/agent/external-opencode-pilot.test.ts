import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import type { AgentClient, AgentSessionConfig } from "./agent-sdk-types.js";
import { OpenCodeAgentClient } from "./providers/opencode-agent.js";
import { wrapClientProvider } from "./provider-registry.js";
import {
  TestOpenCodeClient,
  TestOpenCodeHarness,
} from "./providers/opencode/test-utils/test-opencode-harness.js";
import {
  ManualObservationTiming,
  flushObservation,
  observationDeferred,
} from "./providers/opencode/test-utils/manual-observation-timing.js";
import { ExternalOpenCodeAdoptionConfigSchema } from "./external-opencode-types.js";
import { ExternalOpenCodeAdoption } from "./external-opencode-adoption.js";
import { FileBackedProjectRegistry, FileBackedWorkspaceRegistry } from "../workspace-registry.js";
import { createWorkspaceProvisioningService } from "../session/workspace-provisioning/workspace-provisioning-service.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import {
  sendPromptToAgent,
  startAgentRun,
  startCreatedAgentInitialPrompt,
} from "./agent-prompt.js";
import { publishSessionEnrollment } from "./session-enrollment.js";
import { createPaseoToolCatalog } from "./tools/paseo-tools.js";
import {
  createProviderSnapshotManagerStub,
  asDownloadTokenStore,
  asPushNotifications,
  asScheduleService,
  asCheckoutDiffManager,
  asWorkspaceGitService,
  asDaemonConfigStore,
} from "../test-utils/session-stubs.js";
import { Session } from "../session.js";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
const agentId = "12345678-1234-4234-8234-123456789abc";
const workers = [
  "aw-implement",
  "aw-integrate",
  "aw-luna-leaf",
  "aw-research",
  "review",
  "tests",
  "browser",
];

function user(id: string, sessionID = "session-1", agent = "aw-coordinator", text = "pilot input") {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      agent,
      model: { providerID: "test", modelID: "model" },
      time: { created: 200 },
    },
    parts: [{ id: `part-${id}`, sessionID, messageID: id, type: "text", text }],
  };
}
function nativeTurn(id: string, text = "pilot answer") {
  return [
    user(id),
    {
      info: {
        id: `reply-${id}`,
        sessionID: "session-1",
        role: "assistant",
        parentID: id,
        providerID: "test",
        modelID: "model",
        time: { created: 201, completed: 202 },
      },
      parts: [
        { id: `text-${id}`, messageID: `reply-${id}`, sessionID: "session-1", type: "text", text },
      ],
    },
  ];
}

async function fixture(providerId = "opencode") {
  const home = await mkdtemp(join(tmpdir(), "paseo-role-pilot-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const logger = createTestLogger();
  const native = new TestOpenCodeClient();
  const runtime = new TestOpenCodeHarness();
  const timing = new ManualObservationTiming();
  const provider = new OpenCodeAgentClient(
    logger,
    { serverUrl: runtime.server.url },
    { serverManager: runtime, createClient: runtime.createClient, observationTiming: timing },
  );
  const base: AgentClient = {
    provider: "opencode",
    capabilities: provider.capabilities,
    isAvailable: async () => true,
    createSession: provider.createSession.bind(provider),
    resumeSession: provider.resumeSession.bind(provider),
    fetchCatalog: provider.fetchCatalog.bind(provider),
    listExternalOpenCodeSessions: provider.listExternalOpenCodeSessions.bind(provider),
  };
  const storage = new AgentStorage(join(home, "agents"), logger);
  const manager = new AgentManager({
    clients: { [providerId]: wrapClientProvider(providerId, base, [], [], false) },
    registry: storage,
    logger,
  });
  cleanups.push(async () => {
    for (const agent of manager.listAgents()) await manager.closeAgent(agent.id);
    await manager.flush();
  });
  const projects = new FileBackedProjectRegistry(join(home, "projects.json"), logger);
  const workspaces = new FileBackedWorkspaceRegistry(join(home, "workspaces.json"), logger);
  const workspaceProvisioning = createWorkspaceProvisioningService({
    projectRegistry: projects,
    workspaceRegistry: workspaces,
    logger,
    workspaceGitService: {
      getCheckout: async (cwd) => ({
        cwd,
        isGit: false,
        worktreeRoot: null,
        mainRepoRoot: null,
        currentBranch: null,
        remoteUrl: null,
        isPaseoOwnedWorktree: false,
      }),
      getSnapshot: async () => {
        throw new Error("Unexpected git snapshot");
      },
      peekSnapshot: () => null,
    },
  });
  const resume = async (metadata: Record<string, unknown> = {}) => {
    runtime.enqueueClient(native);
    native.sessionGetResponse = { data: { id: "session-1", directory: home } };
    return manager.resumeAgentFromPersistence(
      {
        provider: providerId,
        sessionId: "session-1",
        metadata: {
          cwd: home,
          model: "test/model",
          openCodeServerUrl: runtime.server.url,
          ...metadata,
        },
      },
      { cwd: home, model: "test/model" },
      agentId,
    );
  };
  const observe = async (ms = 100) => {
    await timing.advance(ms);
    await manager.flush();
  };
  const complete = () => {
    native.sessionPromptAsyncImplementation = async (input) => {
      if (typeof input !== "object" || input === null) throw new Error("Missing request");
      const id = Reflect.get(input, "messageID");
      if (typeof id !== "string") throw new Error("Missing native message identity");
      native.sessionMessagesResponse = { data: nativeTurn(id) };
      native.sessionStatusResponse = { data: { "session-1": { type: "idle" } } };
      native.emitEvent({ type: "message.updated", properties: { info: user(id).info } });
      native.emitEvent({ type: "message.updated", properties: { info: nativeTurn(id)[1]?.info } });
      native.emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
      return {};
    };
  };
  const config = (extra: Record<string, unknown> = {}) =>
    ExternalOpenCodeAdoptionConfigSchema.parse({
      enabled: true,
      classificationMode: "reserved-role-pilot",
      activatedAt: new Date(100).toISOString(),
      roots: [{ cwd: home }],
      coordinatorAgentNames: ["aw-coordinator"],
      workerAgentNames: workers,
      ...extra,
    });
  const adoption = (extra: Record<string, unknown> = {}) =>
    new ExternalOpenCodeAdoption({
      config: config(extra),
      endpoint: runtime.server.url,
      statePath: join(home, "adoption.json"),
      agentStorage: storage,
      workspaceProvisioning,
      listSessions: manager.listExternalOpenCodeSessions.bind(manager),
      onAdopted: manager.publishStoredAgent.bind(manager),
      logger,
    });
  const catalog = (rows: unknown[], messages: unknown[] = [user("first")]) => {
    native.experimentalSessionListResponse = { data: rows, response: new Response(null) };
    native.sessionMessagesResponse = { data: messages, response: new Response(null) };
    runtime.enqueueClient(native);
  };
  const row = (id = "session-1", extra: Record<string, unknown> = {}) => ({
    id,
    slug: id,
    projectID: "project",
    directory: home,
    title: "coordinator",
    version: "1.18.30",
    time: { created: 200, updated: 300 },
    project: null,
    ...extra,
  });
  const mobile = () => {
    const messages: SessionOutboundMessage[] = [];
    const session = new Session({
      clientId: "stock-client",
      scopes: ["*"],
      paseoHome: home,
      logger,
      agentManager: manager,
      agentStorage: storage,
      projectRegistry: projects,
      workspaceRegistry: workspaces,
      onMessage: (msg) => messages.push(msg),
      downloadTokenStore: asDownloadTokenStore(),
      pushNotifications: asPushNotifications(),
      scheduleService: asScheduleService(),
      checkoutDiffManager: asCheckoutDiffManager({}),
      workspaceGitService: asWorkspaceGitService({ peekSnapshot: () => null }),
      daemonConfigStore: asDaemonConfigStore({
        get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
        onChange: () => () => {},
      }),
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      stt: null,
      tts: null,
      terminalManager: null,
    });
    cleanups.push(() => session.cleanup());
    return { session, messages };
  };
  return {
    home,
    logger,
    native,
    runtime,
    timing,
    manager,
    storage,
    projects,
    workspaces,
    resume,
    observe,
    complete,
    config,
    adoption,
    catalog,
    row,
    mobile,
  };
}

test("pilot role discovery creates one ordinary resumable history record without TUI enrollment or prompting", async () => {
  const f = await fixture();
  f.catalog([f.row()]);
  await f.adoption().reconcile();
  const records = await f.storage.list();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    lastStatus: "closed",
    persistence: { sessionId: "session-1", metadata: { externalOpenCodePilot: true } },
  });
  f.catalog([f.row()]);
  await f.adoption().reconcile();
  expect((await f.storage.list()).map((record) => record.id)).toEqual([records[0]?.id]);
  expect(await f.workspaces.list()).toHaveLength(1);
  expect(f.native.calls.sessionPromptAsync).toEqual([]);
  expect(f.native.calls.globalEvent).toEqual([]);
  const record = records[0];
  if (!record) throw new Error("Missing adopted record");
  f.runtime.enqueueClient(f.native);
  f.native.sessionGetResponse = { data: { id: "session-1", directory: f.home } };
  const ready = new Promise<void>((resolve) => {
    const unsubscribe = f.manager.subscribe(
      (event) => {
        if (
          event.type === "agent_state" &&
          event.agent.id === record.id &&
          event.agent.lifecycle === "idle"
        ) {
          unsubscribe();
          resolve();
        }
      },
      { replayState: false },
    );
  });
  const loaded = ensureAgentLoaded(record.id, {
    agentManager: f.manager,
    agentStorage: f.storage,
    logger: f.logger,
  });
  await ready;
  await f.observe(0);
  expect(await loaded).toMatchObject({ id: record.id, persistence: { sessionId: "session-1" } });
});

test.each(["opencode", "custom-opencode"])(
  "legacy %s idle sync send reaches the native provider and returns its result",
  async (provider) => {
    const f = await fixture(provider);
    await f.resume();
    await f.observe(0);
    f.complete();
    const result = await f.manager.runAgent(agentId, "pilot input", {
      clientMessageId: "client-message",
    });
    expect(result.finalText).toBe("pilot answer");
    expect(f.native.calls.sessionPromptAsync).toHaveLength(1);
    expect(f.native.calls.sessionAbort).toEqual([]);
  },
);

test.each(["initial", "ordinary", "stream"])(
  "legacy external %s sends retain acceptance and echo behavior",
  async (entrypoint) => {
    const f = await fixture("custom-opencode");
    await f.resume();
    await f.observe(0);
    f.complete();
    if (entrypoint === "initial") {
      await startCreatedAgentInitialPrompt({
        agentManager: f.manager,
        agentId,
        prompt: "pilot input",
        logger: f.logger,
      });
    } else if (entrypoint === "ordinary") {
      const dispatch = await sendPromptToAgent({
        agentManager: f.manager,
        agentStorage: f.storage,
        agentId,
        prompt: "pilot input",
        logger: f.logger,
        messageId: "ordinary",
      });
      expect(dispatch).toMatchObject({ outOfBand: false, accepted: true });
      expect(dispatch.queued).toBeUndefined();
      expect(await dispatch.followUp?.completion).toMatchObject({
        status: "completed",
        lastMessage: "pilot answer",
      });
    } else {
      const events = [];
      for await (const event of f.manager.streamAgent(agentId, "pilot input", {
        clientMessageId: "stream",
      }))
        events.push(event);
      expect(
        events.filter(
          (event) => event.type === "timeline" && event.item.type === "assistant_message",
        ),
      ).toHaveLength(1);
      expect(events.at(-1)?.type).toBe("turn_completed");
    }
    await f.observe();
    expect(f.native.calls.sessionPromptAsync).toHaveLength(1);
    expect(f.native.calls.sessionAbort).toEqual([]);
    expect(
      f.manager.getTimeline(agentId).filter((item) => item.type === "user_message"),
    ).toHaveLength(1);
  },
);

test("pilot busy sends refuse all ordinary entrypoints without implicit abort, while permission/question/Stop remain usable", async () => {
  const f = await fixture();
  f.native.sessionStatusResponse = { data: { "session-1": { type: "busy" } } };
  await f.resume({ externalOpenCodePilot: true, modeId: "aw-coordinator" });
  await f.observe(0);
  await expect(
    sendPromptToAgent({
      agentManager: f.manager,
      agentStorage: f.storage,
      agentId,
      prompt: "must not queue",
      sessionMode: "plan",
      logger: f.logger,
    }),
  ).rejects.toThrow("OpenCode is busy");
  await expect(f.manager.replaceAgentRun(agentId, "replace")).rejects.toThrow("OpenCode is busy");
  await expect(f.manager.runAgent(agentId, "sync")).rejects.toThrow("OpenCode is busy");
  expect(() => f.manager.streamAgent(agentId, "stream")).toThrow("OpenCode is busy");
  const tools = createPaseoToolCatalog({
    agentManager: f.manager,
    agentStorage: f.storage,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    logger: f.logger,
  });
  await expect(
    tools.executeTool("send_agent_prompt", { agentId, prompt: "MCP ordinary", background: false }),
  ).rejects.toThrow("OpenCode is busy");
  expect(f.native.calls.sessionPromptAsync).toEqual([]);
  expect(f.native.calls.sessionAbort).toEqual([]);
  expect(f.manager.getAgent(agentId)?.currentModeId).toBe("aw-coordinator");
  const permission = {
    id: "permission",
    sessionID: "session-1",
    permission: "bash",
    patterns: ["test"],
    always: [],
    metadata: {},
  };
  const question = {
    id: "question",
    sessionID: "session-1",
    questions: [
      { header: "Choice", question: "Which?", options: [{ label: "One", description: "First" }] },
    ],
  };
  f.native.emitEvent({ type: "permission.asked", properties: permission });
  f.native.emitEvent({ type: "question.asked", properties: question });
  await flushObservation();
  await f.manager.flush();
  await f.manager.respondToPermission(agentId, "permission", { behavior: "allow" });
  await f.manager.respondToPermission(agentId, "question", {
    behavior: "allow",
    updatedInput: { answers: { Choice: "One" } },
  });
  expect(f.native.calls.permissionReply).toHaveLength(1);
  expect(f.native.calls.questionReply).toHaveLength(1);
  f.native.sessionAbortImplementation = async () => {
    f.native.sessionStatusResponse = { data: { "session-1": { type: "idle" } } };
    f.native.emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
    return {};
  };
  expect(await f.manager.cancelAgentRun(agentId)).toEqual({ status: "settled" });
  expect(f.native.calls.sessionAbort).toHaveLength(1);
  f.complete();
  const dispatch = await sendPromptToAgent({
    agentManager: f.manager,
    agentStorage: f.storage,
    agentId,
    prompt: "pilot input",
    logger: f.logger,
  });
  expect(await dispatch.followUp?.completion).toMatchObject({
    status: "completed",
    lastMessage: "pilot answer",
  });
  expect(f.native.calls.sessionPromptAsync).toHaveLength(1);
});

test("final native busy check rejects before acceptance and exposes observed activity for explicit Stop", async () => {
  const f = await fixture();
  await f.resume({ externalOpenCodePilot: true });
  await f.observe(0);
  f.native.sessionStatusResponse = { data: { "session-1": { type: "busy" } } };
  await expect(startAgentRun(f.manager, agentId, "late busy", f.logger)).rejects.toThrow(
    "OpenCode is busy",
  );
  await f.manager.flush();
  expect(f.native.calls.sessionPromptAsync).toEqual([]);
  expect(f.native.calls.sessionAbort).toEqual([]);
  expect(f.manager.getTimeline(agentId)).toEqual([]);
  expect(f.manager.getAgent(agentId)?.lifecycle).toBe("running");
  expect(await f.manager.cancelAgentRun(agentId)).toEqual({ status: "settled" });
  expect(f.native.calls.sessionAbort).toHaveLength(1);
});

test("pilot idle blocking MCP follows the real submitted native message result", async () => {
  const f = await fixture();
  await f.resume({ externalOpenCodePilot: true });
  await f.observe(0);
  f.complete();
  const tools = createPaseoToolCatalog({
    agentManager: f.manager,
    agentStorage: f.storage,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    logger: f.logger,
  });
  const result = await tools.executeTool("send_agent_prompt", {
    agentId,
    prompt: "pilot input",
    background: false,
  });
  expect(result.structuredContent).toMatchObject({
    success: true,
    status: "idle",
    lastMessage: "pilot answer",
  });
  expect(f.native.calls.sessionPromptAsync).toHaveLength(1);
});

test.each(workers)(
  "pilot excludes CLI/worker provenance %s even after a coordinator turn",
  async (worker) => {
    const f = await fixture();
    f.catalog([f.row()], [user("worker", "session-1", worker), user("coordinator")]);
    await f.adoption().reconcile();
    expect(await f.storage.list()).toEqual([]);
  },
);

test.each(["child", "unknown", "mixed", "empty", "archived", "outside", "old"])(
  "pilot excludes %s native sessions",
  async (kind) => {
    const f = await fixture();
    const overrides: Record<string, Record<string, unknown>> = {
      child: { parentID: "parent" },
      unknown: {},
      mixed: {},
      empty: {},
      archived: { time: { created: 200, updated: 300, archived: 250 } },
      outside: { directory: join(f.home, "other") },
      old: { time: { created: 100, updated: 300 } },
    };
    const messages =
      kind === "empty"
        ? []
        : [user("first", "session-1", kind === "unknown" ? "build" : "aw-coordinator")];
    if (kind === "mixed") messages.push(user("unknown", "session-1", "build"));
    f.catalog([f.row("session-1", overrides[kind])], messages);
    await f.adoption().reconcile();
    expect(await f.storage.list()).toEqual([]);
  },
);

test("pilot honors explicit exclusions and optional enrollment-file negative authority", async () => {
  const f = await fixture();
  const directory = join(f.home, "enrollment");
  await publishSessionEnrollment(directory, {
    version: 1,
    endpoint: f.runtime.server.url,
    sessionId: "session-1",
    cwd: f.home,
    classification: "worker",
    provenance: { producer: "fixture", kind: "worker-reservation", eventId: "worker" },
  });
  f.catalog([f.row()]);
  await f.adoption({ enrollmentDirectory: directory }).reconcile();
  expect(await f.storage.list()).toEqual([]);
  f.catalog([f.row("excluded")], [user("first", "excluded")]);
  await f.adoption({ excludedSessionIds: ["excluded"] }).reconcile();
  expect(await f.storage.list()).toEqual([]);
});

test("omitted classification mode stays strict and requires file enrollment despite coordinator names", async () => {
  const f = await fixture();
  expect(f.config({ classificationMode: undefined }).classificationMode).toBe("file-enrollment");
  f.catalog([f.row()]);
  await expect(f.adoption({ classificationMode: undefined }).reconcile()).rejects.toThrow(
    "authoritative enrollmentDirectory",
  );
  expect(await f.storage.list()).toEqual([]);
  const directory = join(f.home, "enrollment");
  await publishSessionEnrollment(directory, {
    version: 1,
    endpoint: f.runtime.server.url,
    sessionId: "session-1",
    cwd: f.home,
    classification: "coordinator",
    provenance: { producer: "fixture-tui", kind: "tui-session", eventId: "created" },
  });
  f.catalog([f.row()]);
  await f.adoption({ classificationMode: undefined, enrollmentDirectory: directory }).reconcile();
  const [record] = await f.storage.list();
  expect(record?.persistence?.metadata?.externalOpenCodePilot).toBeUndefined();
  expect(record?.persistence?.sessionId).toBe("session-1");
});

test("sessions becoming meaningful after discovery appear once; archived records are never restored", async () => {
  const f = await fixture();
  f.catalog([f.row()], []);
  await f.adoption().reconcile();
  expect(await f.storage.list()).toEqual([]);
  f.catalog([f.row()]);
  await f.adoption().reconcile();
  const [first] = await f.storage.list();
  if (!first) throw new Error("Missing coordinator");
  await f.storage.upsert({ ...first, archivedAt: new Date(400).toISOString() });
  f.catalog([f.row()]);
  await f.adoption().reconcile();
  expect(await f.storage.get(first.id)).toMatchObject({ archivedAt: new Date(400).toISOString() });
  f.catalog(
    [f.row("created-after-startup", { time: { created: 500, updated: 600 } })],
    [user("new-first", "created-after-startup")],
  );
  await f.adoption().reconcile();
  expect((await f.storage.list()).map((row) => row.persistence?.sessionId).sort()).toEqual([
    "created-after-startup",
    "session-1",
  ]);
});

test("stock send-response path reports final busy refusal and idle acceptance with canonical request identity", async () => {
  const f = await fixture();
  await f.resume({ externalOpenCodePilot: true });
  await f.observe(0);
  const mobile = f.mobile();
  f.native.sessionStatusResponse = { data: { "session-1": { type: "busy" } } };
  await mobile.session.handleMessage({
    type: "send_agent_message_request",
    requestId: "busy",
    agentId,
    text: "pilot input",
  });
  expect(mobile.messages.filter((msg) => msg.type === "send_agent_message_response")).toMatchObject(
    [
      {
        payload: {
          requestId: "busy",
          accepted: false,
          error: expect.stringContaining("OpenCode is busy"),
        },
      },
    ],
  );
  expect(f.native.calls.sessionAbort).toEqual([]);
  expect(f.native.calls.sessionPromptAsync).toEqual([]);
  f.native.sessionStatusResponse = { data: { "session-1": { type: "idle" } } };
  f.native.emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
  await flushObservation();
  await f.manager.flush();
  f.complete();
  await mobile.session.handleMessage({
    type: "send_agent_message_request",
    requestId: "idle",
    agentId,
    text: "pilot input",
  });
  const replies = mobile.messages.filter((msg) => msg.type === "send_agent_message_response");
  expect(replies.at(-1)?.payload).toMatchObject({ requestId: "idle", accepted: true, error: null });
  await f.observe();
  expect(f.manager.getTimeline(agentId).filter((item) => item.type === "user_message")).toEqual([
    { type: "user_message", text: "pilot input", messageId: "idle", clientMessageId: "idle" },
  ]);
});

test("explicit pilot creation config survives native handle persistence and admits an idle initial prompt", async () => {
  const f = await fixture();
  f.runtime.enqueueClient(f.native);
  const config: AgentSessionConfig = {
    provider: "opencode",
    cwd: f.home,
    model: "test/model",
    modeId: "aw-coordinator",
    externalOpenCodePilot: true,
  };
  const agent = await f.manager.createAgent(config, agentId, { workspaceId: "workspace" });
  f.complete();
  await startCreatedAgentInitialPrompt({
    agentManager: f.manager,
    agentId: agent.id,
    prompt: "pilot input",
    logger: f.logger,
  });
  await f.observe();
  expect((await f.storage.get(agentId))?.persistence?.metadata?.externalOpenCodePilot).toBe(true);
  expect(f.native.calls.sessionPromptAsync).toHaveLength(1);
});

test("local serialization rejects a second pilot send while the first admission is preparing", async () => {
  const f = await fixture();
  await f.resume({ externalOpenCodePilot: true });
  await f.observe(0);
  f.complete();
  const entered = observationDeferred<void>();
  const ready = observationDeferred<{ data: Record<string, { type: "idle" }> }>();
  f.native.sessionStatusImplementation = () => {
    entered.resolve();
    return ready.promise;
  };
  const first = sendPromptToAgent({
    agentManager: f.manager,
    agentStorage: f.storage,
    agentId,
    prompt: "pilot input",
    logger: f.logger,
  });
  await entered.promise;
  await expect(
    sendPromptToAgent({
      agentManager: f.manager,
      agentStorage: f.storage,
      agentId,
      prompt: "second",
      logger: f.logger,
    }),
  ).rejects.toThrow("OpenCode is busy");
  ready.resolve({ data: { "session-1": { type: "idle" } } });
  expect((await first).accepted).toBe(true);
  expect(f.native.calls.sessionPromptAsync).toHaveLength(1);
  expect(f.native.calls.sessionAbort).toEqual([]);
});

test("a lost native acknowledgement is exposed as uncertain rather than accepted or automatically retried", async () => {
  const f = await fixture();
  await f.resume({ externalOpenCodePilot: true });
  await f.observe(0);
  f.native.sessionPromptAsyncImplementation = async () => ({
    error: new Error("lost acknowledgement"),
  });
  await expect(
    sendPromptToAgent({
      agentManager: f.manager,
      agentStorage: f.storage,
      agentId,
      prompt: "pilot input",
      logger: f.logger,
    }),
  ).rejects.toThrow("uncertain");
  await f.manager.flush();
  expect(
    (await f.storage.get(agentId))?.persistence?.metadata?.openCodeNativeSubmissions,
  ).toMatchObject([{ delivery: "uncertain" }]);
  expect(f.native.calls.sessionPromptAsync).toHaveLength(1);
  expect(f.native.calls.sessionAbort).toEqual([]);
});

test("disabled pilot adoption makes no catalog or runtime calls", async () => {
  const f = await fixture();
  await f.adoption({ enabled: false }).reconcile();
  expect(f.runtime.acquisitions).toEqual([]);
  expect(await f.storage.list()).toEqual([]);
});

test("nonpilot external aliases retain legacy replacement behavior for ordinary busy sends", async () => {
  const f = await fixture("custom-opencode");
  f.native.sessionStatusResponse = { data: { "session-1": { type: "busy" } } };
  await f.resume();
  await f.observe(0);
  f.native.sessionAbortImplementation = async () => {
    f.native.sessionStatusResponse = { data: { "session-1": { type: "idle" } } };
    f.native.emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
    return {};
  };
  f.complete();
  const dispatch = await sendPromptToAgent({
    agentManager: f.manager,
    agentStorage: f.storage,
    agentId,
    prompt: "pilot input",
    logger: f.logger,
  });
  expect(dispatch.accepted).toBe(true);
  expect(await dispatch.followUp?.completion).toMatchObject({
    status: "completed",
    lastMessage: "pilot answer",
  });
  expect(f.native.calls.sessionAbort).toHaveLength(1);
  expect(f.native.calls.sessionPromptAsync).toHaveLength(1);
});

test("pilot refuses input while an acknowledged Stop still awaits native idle", async () => {
  const f = await fixture();
  f.native.sessionStatusResponse = { data: { "session-1": { type: "busy" } } };
  await f.resume({ externalOpenCodePilot: true });
  await f.observe(0);
  expect(await f.manager.cancelAgentRun(agentId)).toEqual({ status: "settled" });
  await expect(
    sendPromptToAgent({
      agentManager: f.manager,
      agentStorage: f.storage,
      agentId,
      prompt: "must not wait in a queue",
      logger: f.logger,
    }),
  ).rejects.toThrow("OpenCode is busy");
  expect(f.native.calls.sessionAbort).toHaveLength(1);
  expect(f.native.calls.sessionPromptAsync).toEqual([]);
});

test("explicit pilot provider config checks native busy even without a caller admission fence", async () => {
  const f = await fixture();
  const managed = await f.resume({ externalOpenCodePilot: true });
  await f.observe(0);
  f.native.sessionStatusResponse = { data: { "session-1": { type: "busy" } } };
  if (!managed.session) throw new Error("Missing provider session");
  await expect(managed.session.startTurn("direct pilot input")).rejects.toThrow("OpenCode is busy");
  expect(f.native.calls.sessionPromptAsync).toEqual([]);
  expect(f.native.calls.sessionAbort).toEqual([]);
});
