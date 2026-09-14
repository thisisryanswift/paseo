import { describe, expect, test } from "vitest";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import {
  supportsOpenCodeNativeHistory,
  type OpenCodeHistorySnapshot,
} from "./opencode/native-history.js";
import {
  TestOpenCodeClient,
  TestOpenCodeHarness,
} from "./opencode/test-utils/test-opencode-harness.js";
import {
  ManualObservationTiming,
  flushObservation,
  observationDeferred,
} from "./opencode/test-utils/manual-observation-timing.js";

const permission = {
  id: "permission-1",
  sessionID: "session-1",
  permission: "bash",
  patterns: ["npm run build"],
  always: [],
  metadata: {},
};
const question = {
  id: "question-1",
  sessionID: "session-1",
  questions: [
    {
      header: "Choice",
      question: "Which option?",
      options: [{ label: "One", description: "First" }],
    },
  ],
};

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  agent = "build",
  model = "model-1",
) {
  return {
    info: {
      id,
      role,
      sessionID: "session-1",
      agent,
      model: { providerID: "test", modelID: model },
      providerID: "test",
      modelID: model,
      time: { created: 1, completed: 2 },
    },
    parts: [
      {
        id: `part-${id}`,
        messageID: id,
        sessionID: "session-1",
        type: "text",
        text,
        time: { start: 1, end: 2 },
      },
    ],
  };
}

async function setup(openCode = new TestOpenCodeClient()) {
  const runtime = new TestOpenCodeHarness();
  runtime.enqueueClient(openCode);
  const timing = new ManualObservationTiming();
  const client = new OpenCodeAgentClient(
    createTestLogger(),
    { serverUrl: runtime.server.url },
    {
      serverManager: runtime,
      createClient: runtime.createClient,
      observationTiming: timing,
    },
  );
  const session = await client.resumeSession({
    provider: "opencode",
    sessionId: "session-1",
    metadata: { cwd: "/workspace/repo", openCodeServerUrl: runtime.server.url },
  });
  if (!supportsOpenCodeNativeHistory(session))
    throw new Error("Expected native observation support");
  const events: AgentStreamEvent[] = [];
  const snapshots: OpenCodeHistorySnapshot[] = [];
  const pending: string[][] = [];
  const unsubscribeHistory = session.subscribeNativeHistory(async (snapshot) => {
    snapshots.push(snapshot);
  });
  session.subscribeNativeRequests((requests) =>
    pending.push(requests.map((request) => request.id)),
  );
  session.subscribe((event) => events.push(event));
  return { session, openCode, runtime, timing, events, snapshots, pending, unsubscribeHistory };
}

function timelineText(snapshot: OpenCodeHistorySnapshot | undefined) {
  return snapshot?.map((event) => ("text" in event.item ? event.item.text : event.item.type));
}

describe("OpenCode handoff observation", () => {
  test("hydrates pending requests on attach, removes terminal answers once, and detaches without aborting", async () => {
    const openCode = new TestOpenCodeClient();
    openCode.permissionListResponse = {
      data: [permission, { ...permission, id: "other", sessionID: "other-session" }],
    };
    openCode.questionListResponse = { data: [question] };
    openCode.sessionStatusResponse = { data: { "session-1": { type: "busy" } } };
    const ctx = await setup(openCode);
    try {
      await ctx.timing.advance(0);
      expect(ctx.session.getPendingPermissions().map((request) => request.id)).toEqual([
        "permission-1",
        "question-1",
      ]);
      expect(ctx.events.filter((event) => event.type === "turn_started")).toHaveLength(1);
      openCode.emitEvent({
        type: "permission.replied",
        properties: { sessionID: "session-1", requestID: permission.id, reply: "always" },
      });
      openCode.emitEvent({
        type: "question.rejected",
        properties: { sessionID: "session-1", requestID: question.id },
      });
      openCode.emitEvent({
        type: "question.rejected",
        properties: { sessionID: "session-1", requestID: question.id },
      });
      await flushObservation();
      expect(ctx.session.getPendingPermissions()).toEqual([]);
      expect(ctx.pending.at(-1)).toEqual([]);
      expect(ctx.events.filter((event) => event.type === "permission_resolved")).toEqual([
        {
          type: "permission_resolved",
          provider: "opencode",
          requestId: permission.id,
          resolution: { behavior: "allow", selectedActionId: "allow_always" },
        },
        {
          type: "permission_resolved",
          provider: "opencode",
          requestId: question.id,
          resolution: { behavior: "deny" },
        },
      ]);
    } finally {
      await ctx.session.close();
    }
    expect(openCode.calls.sessionPromptAsync).toEqual([]);
    expect(openCode.calls.sessionAbort).toEqual([]);
    expect(openCode.calls.sessionDelete).toEqual([]);
    expect(ctx.runtime.acquisitions.at(-1)?.releaseCount).toBe(1);
    expect(ctx.timing.pendingCount).toBe(0);
  });

  test("a terminal reply arriving during the pending-list read cannot resurrect a request", async () => {
    const ctx = await setup();
    const gate = observationDeferred<{ data: (typeof permission)[] }>();
    ctx.openCode.permissionListImplementation = () => gate.promise;
    try {
      ctx.openCode.emitEvent({ type: "permission.asked", properties: permission });
      await ctx.timing.advance(0);
      expect(ctx.session.getPendingPermissions().map((request) => request.id)).toEqual([
        permission.id,
      ]);
      ctx.openCode.emitEvent({
        type: "permission.replied",
        properties: { sessionID: "session-1", requestID: permission.id, reply: "reject" },
      });
      await flushObservation();
      ctx.openCode.permissionListImplementation = null;
      gate.resolve({ data: [permission] });
      await ctx.timing.advance(100);
      expect(ctx.session.getPendingPermissions()).toEqual([]);
      expect(ctx.events.filter((event) => event.type === "permission_requested")).toHaveLength(1);
    } finally {
      await ctx.session.close();
    }
  });

  test("reconnect replaces missed external turns with no active Paseo dispatch and resolves missed request membership", async () => {
    const openCode = new TestOpenCodeClient();
    const disconnect = observationDeferred<void>();
    let attempt = 0;
    openCode.globalEventImplementation = async () => {
      attempt += 1;
      return {
        stream:
          attempt === 1
            ? {
                [Symbol.asyncIterator]: () => ({
                  next: async () => {
                    await disconnect.promise;
                    return { done: true, value: undefined };
                  },
                }),
              }
            : openCode.eventStream,
      };
    };
    openCode.sessionMessagesResponse = { data: [message("u1", "user", "before disconnect")] };
    openCode.permissionListResponse = { data: [permission] };
    const ctx = await setup(openCode);
    try {
      await ctx.timing.advance(0);
      expect(timelineText(ctx.snapshots.at(-1))).toEqual(["before disconnect"]);
      openCode.sessionMessagesResponse = {
        data: [
          message("u1", "user", "before disconnect"),
          message("u2", "user", "terminal follow-up"),
          message("a2", "assistant", "completed elsewhere"),
        ],
      };
      openCode.permissionListResponse = { data: [] };
      disconnect.resolve();
      await ctx.timing.advance(100);
      expect(openCode.calls.globalEvent).toHaveLength(2);
      expect(timelineText(ctx.snapshots.at(-1))).toEqual([
        "before disconnect",
        "terminal follow-up",
        "completed elsewhere",
      ]);
      expect(ctx.pending.at(-1)).toEqual([]);
      expect(ctx.events.filter((event) => event.type === "permission_resolved")).toEqual([]);
      expect(
        ctx.events.filter((event) => event.type === "timeline" || event.type === "turn_failed"),
      ).toEqual([]);
      expect(openCode.calls.sessionPromptAsync).toEqual([]);
    } finally {
      await ctx.session.close();
    }
  });

  test("snapshot/subscription overlap reconciles an inactive terminal message without duplicate append events", async () => {
    const ctx = await setup();
    const old = message("u1", "user", "old");
    const current = message("u2", "user", "arrived during attach");
    const gate = observationDeferred<{ data: ReturnType<typeof message>[] }>();
    ctx.openCode.sessionMessagesImplementation = () => gate.promise;
    try {
      await ctx.timing.advance(0);
      ctx.openCode.emitEvent({ type: "message.updated", properties: { info: current.info } });
      ctx.openCode.emitEvent({
        type: "message.part.updated",
        properties: { part: current.parts[0] },
      });
      await flushObservation();
      ctx.openCode.sessionMessagesImplementation = null;
      ctx.openCode.sessionMessagesResponse = { data: [old, current] };
      gate.resolve({ data: [old] });
      await ctx.timing.advance(100);
      expect(ctx.snapshots.map(timelineText)).toEqual([["old"], ["old", "arrived during attach"]]);
      expect(ctx.events.filter((event) => event.type === "timeline")).toEqual([]);
    } finally {
      await ctx.session.close();
    }
  });

  test("history read failures retain the last snapshot and retry instead of publishing empty history", async () => {
    const ctx = await setup();
    ctx.openCode.sessionMessagesResponse = { data: [message("u1", "user", "retained")] };
    try {
      await ctx.timing.advance(0);
      ctx.openCode.sessionMessagesResponse = { error: { message: "unavailable" } };
      ctx.openCode.emitEvent({
        type: "message.updated",
        properties: { info: message("u2", "user", "new").info },
      });
      await ctx.timing.advance(100);
      expect(ctx.snapshots.map(timelineText)).toEqual([["retained"]]);
      const readHistory = async () => {
        for await (const _event of ctx.session.streamHistory()) {
          /* exhaust */
        }
      };
      await expect(readHistory()).rejects.toThrow("Failed to read OpenCode history");
      ctx.openCode.sessionMessagesResponse = {
        data: [message("u1", "user", "retained"), message("u2", "user", "new")],
      };
      await ctx.timing.advance(200);
      expect(timelineText(ctx.snapshots.at(-1))).toEqual(["retained", "new"]);
    } finally {
      await ctx.session.close();
    }
  });

  test("latest user agent/model wins over old turns and internal compaction, and a newer mobile selection survives a read race", async () => {
    const ctx = await setup();
    const messages = [
      message("u1", "user", "first", "plan", "old"),
      message("u2", "user", "latest", "coordinator", "new"),
      message("a3", "assistant", "internal summary", "compaction", "internal"),
    ];
    ctx.openCode.sessionMessagesResponse = { data: messages };
    try {
      await ctx.timing.advance(0);
      expect(await ctx.session.getRuntimeInfo()).toMatchObject({
        model: "test/new",
        modeId: "coordinator",
      });
      const gate = observationDeferred<{ data: typeof messages }>();
      ctx.openCode.sessionMessagesImplementation = () => gate.promise;
      ctx.openCode.emitEvent({ type: "message.updated", properties: { info: messages[1].info } });
      await ctx.timing.advance(100);
      await ctx.session.setModel("test/mobile");
      await ctx.session.setMode("reviewer");
      gate.resolve({ data: messages });
      await flushObservation();
      expect(await ctx.session.getRuntimeInfo()).toMatchObject({
        model: "test/mobile",
        modeId: "reviewer",
      });
      expect(ctx.session.describePersistence()?.metadata).toMatchObject({
        model: "test/mobile",
        modeId: "reviewer",
        openCodeServerUrl: ctx.runtime.server.url,
      });
    } finally {
      await ctx.session.close();
    }
  });

  test("a terminal question answer retains the actual choice; failed mobile replies remain pending", async () => {
    const ctx = await setup();
    ctx.openCode.questionListResponse = { data: [question] };
    ctx.openCode.questionReplyResponse = { error: { message: "offline" } };
    try {
      await ctx.timing.advance(0);
      await expect(
        ctx.session.respondToPermission(question.id, {
          behavior: "allow",
          updatedInput: { answers: { Choice: "One" } },
        }),
      ).rejects.toThrow("offline");
      expect(ctx.session.getPendingPermissions().map((request) => request.id)).toEqual([
        question.id,
      ]);
      ctx.openCode.emitEvent({
        type: "question.replied",
        properties: { sessionID: "session-1", requestID: question.id, answers: [["One"]] },
      });
      await flushObservation();
      expect(ctx.session.getPendingPermissions()).toEqual([]);
      expect(ctx.events.filter((event) => event.type === "permission_resolved")).toEqual([
        {
          type: "permission_resolved",
          provider: "opencode",
          requestId: question.id,
          resolution: { behavior: "allow", updatedInput: { answers: { Choice: "One" } } },
        },
      ]);
    } finally {
      await ctx.session.close();
    }
  });

  test("reconnect during a running external turn catches up partial content then observes completion once", async () => {
    const openCode = new TestOpenCodeClient();
    const disconnect = observationDeferred<void>();
    let attempt = 0;
    openCode.globalEventImplementation = async () => {
      attempt += 1;
      return {
        stream:
          attempt === 1
            ? {
                [Symbol.asyncIterator]: () => ({
                  next: async () => {
                    await disconnect.promise;
                    return { done: true, value: undefined };
                  },
                }),
              }
            : openCode.eventStream,
      };
    };
    openCode.sessionStatusResponse = { data: { "session-1": { type: "busy" } } };
    openCode.sessionMessagesResponse = { data: [message("a1", "assistant", "partial")] };
    const ctx = await setup(openCode);
    try {
      await ctx.timing.advance(0);
      openCode.sessionMessagesResponse = {
        data: [message("a1", "assistant", "partial and missed suffix")],
      };
      disconnect.resolve();
      await ctx.timing.advance(100);
      expect(timelineText(ctx.snapshots.at(-1))).toEqual(["partial and missed suffix"]);
      expect(ctx.events.filter((event) => event.type === "turn_started")).toHaveLength(1);
      expect(
        ctx.events.filter(
          (event) => event.type === "turn_completed" || event.type === "turn_failed",
        ),
      ).toEqual([]);
      openCode.emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
      await flushObservation();
      expect(ctx.events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
      expect(ctx.events.filter((event) => event.type === "timeline")).toEqual([]);
    } finally {
      await ctx.session.close();
    }
  });

  test("a missed session error is recovered as failure rather than successful idle", async () => {
    const ctx = await setup();
    ctx.openCode.sessionStatusResponse = { data: { "session-1": { type: "busy" } } };
    try {
      await ctx.timing.advance(0);
      const failed = message("a1", "assistant", "partial");
      ctx.openCode.sessionMessagesResponse = {
        data: [
          {
            ...failed,
            info: {
              ...failed.info,
              error: { name: "UnknownError", data: { message: "provider lost credentials" } },
            },
          },
        ],
      };
      ctx.openCode.sessionStatusResponse = { data: {} };
      // The watchdog reconnect is a real consumer transition, not a fabricated lifecycle event.
      await ctx.timing.advance(30_100);
      expect(ctx.events.filter((event) => event.type === "turn_completed")).toEqual([]);
      expect(ctx.events.filter((event) => event.type === "turn_failed")).toMatchObject([
        {
          type: "turn_failed",
          error: '{"name":"UnknownError","data":{"message":"provider lost credentials"}}',
        },
      ]);
    } finally {
      await ctx.session.close();
    }
  });

  test("detach cancels a blocked snapshot consumer without waiting for the manager queue", async () => {
    const ctx = await setup();
    ctx.unsubscribeHistory();
    const gate = observationDeferred<void>();
    let applied = 0;
    ctx.session.subscribeNativeHistory(async (_snapshot, signal) => {
      await gate.promise;
      if (!signal.aborted) applied += 1;
    });
    await ctx.timing.advance(0);
    await ctx.session.close();
    gate.resolve();
    await flushObservation();
    expect(applied).toBe(0);
    expect(ctx.timing.pendingCount).toBe(0);
    expect(ctx.openCode.calls.sessionAbort).toEqual([]);
  });

  test("attach hydrates pending requests from a discovered child's actual directory", async () => {
    const openCode = new TestOpenCodeClient();
    openCode.sessionChildrenResponses = [
      { data: [{ id: "child", parentID: "session-1", directory: "/workspace/child" }] },
    ];
    openCode.permissionListImplementation = async (parameters) => ({
      data:
        (parameters as { directory: string }).directory === "/workspace/child"
          ? [{ ...permission, sessionID: "child" }]
          : [],
    });
    const ctx = await setup(openCode);
    try {
      await ctx.timing.advance(100);
      expect(ctx.session.getPendingPermissions().map((request) => request.id)).toEqual([
        permission.id,
      ]);
      await ctx.session.respondToPermission(permission.id, { behavior: "allow" });
      expect(openCode.calls.permissionReply).toEqual([
        {
          requestID: permission.id,
          directory: "/workspace/child",
          reply: "once",
          message: undefined,
        },
      ]);
    } finally {
      await ctx.session.close();
    }
  });

  test("history observation makes progress even when each read overlaps more streaming output", async () => {
    const ctx = await setup();
    let reads = 0;
    ctx.openCode.sessionMessagesImplementation = async () => {
      reads += 1;
      const current = message("a1", "assistant", `output ${reads}`);
      ctx.openCode.emitEvent({ type: "message.updated", properties: { info: current.info } });
      await flushObservation();
      return { data: [current] };
    };
    try {
      await ctx.timing.advance(0);
      await flushObservation();
      expect(ctx.snapshots.map(timelineText)).toEqual([["output 1"]]);
      await ctx.timing.advance(100);
      await flushObservation();
      expect(ctx.snapshots.map(timelineText)).toEqual([["output 1"], ["output 2"]]);
      expect(ctx.events.filter((event) => event.type === "timeline")).toEqual([]);
    } finally {
      await ctx.session.close();
    }
  });

  test("recovery does not attribute a previous turn's error to a later native user message", async () => {
    const ctx = await setup();
    ctx.openCode.sessionStatusResponse = { data: { "session-1": { type: "busy" } } };
    try {
      await ctx.timing.advance(0);
      const previous = message("a1", "assistant", "previous failure");
      ctx.openCode.sessionMessagesResponse = {
        data: [
          {
            ...previous,
            info: {
              ...previous.info,
              error: { name: "UnknownError", data: { message: "old failure" } },
            },
          },
          message("u2", "user", "later request"),
        ],
      };
      ctx.openCode.sessionStatusResponse = { data: {} };
      await ctx.timing.advance(30_100);
      expect(ctx.events.filter((event) => event.type === "turn_failed")).toEqual([]);
      expect(ctx.events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
    } finally {
      await ctx.session.close();
    }
  });
});
