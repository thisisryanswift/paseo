import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentStorage } from "./agent-storage.js";
import { ExternalOpenCodeAdoption } from "./external-opencode-adoption.js";
import {
  ExternalOpenCodeAdoptionConfigSchema,
  type ExternalOpenCodeSessionMetadata,
} from "./external-opencode-types.js";
import { FileBackedProjectRegistry, FileBackedWorkspaceRegistry } from "../workspace-registry.js";
import { createWorkspaceProvisioningService } from "../session/workspace-provisioning/workspace-provisioning-service.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const logger = createTestLogger();
const endpoint = "http://opencode.test:4096";
const cutoff = Date.parse("2026-09-12T00:00:00Z");
function session(id: string, cwd: string): ExternalOpenCodeSessionMetadata {
  return {
    sessionId: id,
    cwd,
    createdAt: cutoff + 1,
    updatedAt: cutoff + 2,
    archivedAt: null,
    parentId: null,
    title: "Coordinator",
    modeId: "coordinator",
    model: "test/model",
    agentNames: ["coordinator"],
    firstUserMessage: { id: `msg-${id}`, agent: "coordinator" },
  };
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "paseo-adoption-"));
  homes.push(home);
  const cwd = join(home, "project");
  await mkdir(cwd);
  const config = ExternalOpenCodeAdoptionConfigSchema.parse({
    enabled: true,
    activatedAt: new Date(cutoff).toISOString(),
    roots: [{ cwd }],
    coordinatorAgentNames: ["coordinator"],
    workerAgentNames: ["worker"],
  });
  const storage = new AgentStorage(join(home, "agents"), logger);
  const projects = new FileBackedProjectRegistry(join(home, "projects.json"), logger);
  const workspaces = new FileBackedWorkspaceRegistry(join(home, "workspaces.json"), logger);
  const provisioning = createWorkspaceProvisioningService({
    projectRegistry: projects,
    workspaceRegistry: workspaces,
    logger,
    workspaceGitService: {
      getCheckout: async (path) => ({
        cwd: path,
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
  let sessions = [session("native-1", cwd)];
  let failure: Error | null = null;
  const make = (
    agentStorage = storage,
    overrides: Partial<ConstructorParameters<typeof ExternalOpenCodeAdoption>[0]> = {},
  ) =>
    new ExternalOpenCodeAdoption({
      config,
      endpoint,
      statePath: join(home, "adoption.json"),
      agentStorage,
      workspaceProvisioning: provisioning,
      logger,
      listSessions: async () => {
        if (failure) throw failure;
        return { endpoint, sessions };
      },
      onAdopted: () => {},
      readEnrollments: async () =>
        sessions
          .filter((row) => row.firstUserMessage?.agent === "coordinator")
          .map((row) => ({
            version: 1 as const,
            endpoint,
            sessionId: row.sessionId,
            cwd: row.cwd,
            classification: "coordinator" as const,
            provenance: {
              producer: "test-tui",
              kind: "tui-session" as const,
              eventId: `enroll-${row.sessionId}`,
            },
          })),
      ...overrides,
    });
  return {
    home,
    cwd,
    config,
    storage,
    projects,
    workspaces,
    make,
    setSessions: (rows: ExternalOpenCodeSessionMetadata[]) => {
      sessions = rows;
    },
    fail: (error: Error | null) => {
      failure = error;
    },
  };
}

test("repeated and concurrent discovery, then restart, retain one native agent and workspace", async () => {
  const f = await fixture();
  const adoption = f.make();
  await Promise.all([adoption.reconcile(), adoption.reconcile(), f.make().reconcile()]);
  const [record] = await f.storage.list();
  expect(record).toMatchObject({
    cwd: f.cwd,
    lastStatus: "closed",
    config: { modeId: "coordinator", model: "test/model" },
    persistence: { sessionId: "native-1", metadata: { openCodeServerUrl: endpoint } },
  });
  const restarted = new AgentStorage(join(f.home, "agents"), logger);
  await f.make(restarted).reconcile();
  expect((await restarted.list()).map((row) => row.id)).toEqual([record!.id]);
  expect((await f.workspaces.list()).map((row) => row.workspaceId)).toEqual([record!.workspaceId]);
});

test("workers including standalone roots, unknowns, empty sessions, archives and pre-cutoff sessions stay out", async () => {
  const f = await fixture();
  const row = session("eligible", f.cwd);
  f.setSessions([
    { ...row, sessionId: "worker", agentNames: ["worker"] },
    { ...row, sessionId: "child", parentId: "parent" },
    { ...row, sessionId: "unknown", firstUserMessage: { id: "m", agent: "unknown" } },
    { ...row, sessionId: "empty", firstUserMessage: null },
    { ...row, sessionId: "archive", archivedAt: cutoff + 10 },
    { ...row, sessionId: "old", createdAt: cutoff },
    { ...row, sessionId: "elsewhere", cwd: join(f.cwd, "nested") },
    row,
  ]);
  await f.make().reconcile();
  expect((await f.storage.list()).map((record) => record.persistence?.sessionId)).toEqual([
    "eligible",
  ]);
  expect(await f.workspaces.list()).toHaveLength(1);
});

test("discovers actual sessions created or made meaningful after initial TUI discovery", async () => {
  const f = await fixture();
  f.setSessions([{ ...session("empty", f.cwd), firstUserMessage: null }]);
  await f.make().reconcile();
  expect(await f.storage.list()).toEqual([]);
  f.setSessions([session("empty", f.cwd), session("created-later", f.cwd)]);
  await f.make().reconcile();
  f.setSessions([session("created-later", f.cwd), session("empty", f.cwd)]);
  await f.make().reconcile();
  expect((await f.storage.list()).map((record) => record.persistence?.sessionId).sort()).toEqual([
    "created-later",
    "empty",
  ]);
  expect(await f.workspaces.list()).toHaveLength(1);
});

test("list errors reject rather than masquerading as an empty successful catalog", async () => {
  const f = await fixture();
  f.fail(new Error("upstream unavailable"));
  await expect(f.make().reconcile()).rejects.toThrow("upstream unavailable");
  expect(await f.storage.list()).toEqual([]);
  f.fail(null);
  f.setSessions([]);
  await f.make().reconcile();
  expect(await f.workspaces.list()).toEqual([]);
  f.setSessions([session("recovered", f.cwd)]);
  await f.make().reconcile();
  expect(await f.storage.list()).toHaveLength(1);
});

test("native archives and explicit exclusions leave tombstones after restart", async () => {
  const f = await fixture();
  f.config.excludedSessionIds = ["excluded"];
  f.setSessions([
    { ...session("archived", f.cwd), archivedAt: cutoff + 1 },
    session("excluded", f.cwd),
  ]);
  await f.make().reconcile();
  f.config.excludedSessionIds = [];
  f.setSessions([session("archived", f.cwd), session("excluded", f.cwd)]);
  await f.make().reconcile();
  expect(await f.storage.list()).toEqual([]);
  expect(await f.workspaces.list()).toEqual([]);
});

test("Paseo archive and removal cannot be undone by automatic discovery", async () => {
  const f = await fixture();
  await f.make().reconcile();
  const [record] = await f.storage.list();
  await f.storage.upsert({ ...record!, archivedAt: new Date(cutoff + 10).toISOString() });
  await f.make().reconcile();
  await f.storage.remove(record!.id);
  await f.make(new AgentStorage(join(f.home, "agents"), logger)).reconcile();
  expect(await f.storage.list()).toEqual([]);
  expect(await f.workspaces.list()).toHaveLength(1);
});

test("an existing owner resolves before ambiguous workspace placement", async () => {
  const f = await fixture();
  await f.make().reconcile();
  const [workspace] = await f.workspaces.list();
  await f.workspaces.upsert({ ...workspace!, workspaceId: "second" });
  await f.make().reconcile();
  expect(await f.storage.list()).toHaveLength(1);
  f.setSessions([session("new", f.cwd)]);
  await expect(f.make().reconcile()).rejects.toThrow("Ambiguous adoption workspace");
  f.config.roots[0]!.workspaceId = "second";
  await f.make().reconcile();
  expect(
    (await f.storage.list()).find((record) => record.persistence?.sessionId === "new")?.workspaceId,
  ).toBe("second");
});

test("archive-only workspaces are not restored or replaced", async () => {
  const f = await fixture();
  await f.make().reconcile();
  const [workspace] = await f.workspaces.list();
  await f.workspaces.archive(workspace!.workspaceId, new Date(cutoff + 10).toISOString());
  f.setSessions([session("new", f.cwd)]);
  await expect(f.make().reconcile()).rejects.toThrow("Adoption workspace is archived");
  expect(await f.storage.list()).toHaveLength(1);
  expect(await f.workspaces.list()).toHaveLength(1);
});

test("failed agent persistence leaves a reusable workspace across restart", async () => {
  const f = await fixture();
  class FailingStorage extends AgentStorage {
    override async upsert(): Promise<void> {
      throw new Error("disk full");
    }
  }
  await expect(
    f.make(new FailingStorage(join(f.home, "agents"), logger)).reconcile(),
  ).rejects.toThrow("disk full");
  const [workspace] = await f.workspaces.list();
  expect(await f.storage.list()).toEqual([]);
  await f.make().reconcile();
  expect((await f.storage.list())[0]?.workspaceId).toBe(workspace!.workspaceId);
  expect(await f.workspaces.list()).toHaveLength(1);
});

test("canonical aliases share placement while explicitly registered worktrees stay distinct", async () => {
  const f = await fixture();
  const alias = join(f.home, "alias");
  const worktree = join(f.home, "worktree");
  await symlink(f.cwd, alias);
  await mkdir(worktree);
  f.config.roots.push({ cwd: worktree });
  f.setSessions([
    session("alias", alias),
    session("worktree", worktree),
    session("unregistered", join(worktree, "nested")),
  ]);
  await f.make().reconcile();
  expect((await f.storage.list()).map((record) => record.cwd).sort()).toEqual(
    [f.cwd, worktree].sort(),
  );
  expect(await f.workspaces.list()).toHaveLength(2);
});

test("a persisted activation cutoff never moves backwards and disabled discovery does no work", async () => {
  const f = await fixture();
  f.config.enabled = false;
  f.fail(new Error("must not list"));
  await f.make().reconcile();
  expect(await f.storage.list()).toEqual([]);
  f.config.enabled = true;
  f.fail(null);
  f.setSessions([]);
  await f.make().reconcile();
  f.config.activatedAt = new Date(cutoff - 100).toISOString();
  f.setSessions([{ ...session("old", f.cwd), createdAt: cutoff - 1 }]);
  await f.make().reconcile();
  expect(await f.storage.list()).toEqual([]);
});

test("corrupt exclusion state fails closed", async () => {
  const f = await fixture();
  await writeFile(join(f.home, "adoption.json"), "{broken");
  await expect(f.make().reconcile()).rejects.toThrow();
  expect(await f.storage.list()).toEqual([]);
  expect(await f.workspaces.list()).toEqual([]);
});

test("same native ID on another endpoint is a different conversation", async () => {
  const f = await fixture();
  await f.storage.upsert({
    id: "other-server",
    provider: "opencode",
    cwd: f.cwd,
    labels: {},
    lastStatus: "closed",
    createdAt: new Date(cutoff).toISOString(),
    updatedAt: new Date(cutoff).toISOString(),
    persistence: {
      provider: "opencode",
      sessionId: "native-1",
      metadata: { openCodeServerUrl: "http://other-server" },
    },
  });
  await f.make().reconcile();
  expect(await f.storage.list()).toHaveLength(2);
  expect(await f.storage.listByProviderSession("opencode", "native-1", endpoint)).toHaveLength(1);
  expect(await f.workspaces.list()).toHaveLength(1);
});

test("discovery follows all pages and rejects changing endpoints or nonadvancing cursors", async () => {
  const f = await fixture();
  f.setSessions([session("first-page", f.cwd), session("second-page", f.cwd)]);
  const cursors: Array<string | undefined> = [];
  await f
    .make(f.storage, {
      listSessions: async (input) => {
        cursors.push(input.cursor);
        return input.cursor
          ? { endpoint, sessions: [session("second-page", f.cwd)] }
          : { endpoint, sessions: [session("first-page", f.cwd)], nextCursor: "next" };
      },
    })
    .reconcile();
  expect(cursors).toEqual([undefined, "next"]);
  expect(await f.storage.list()).toHaveLength(2);
  await expect(
    f
      .make(f.storage, {
        listSessions: async () => ({
          endpoint: "http://unexpected",
          sessions: [session("wrong-server", f.cwd)],
        }),
      })
      .reconcile(),
  ).rejects.toThrow("endpoint changed");
  await expect(
    f
      .make(f.storage, {
        listSessions: async () => ({ endpoint, sessions: [], nextCursor: "stuck" }),
      })
      .reconcile(),
  ).rejects.toThrow("cursor did not advance");
  expect(await f.storage.list()).toHaveLength(2);
});

test("failure after both durable writes does not duplicate or republish the agent", async () => {
  const f = await fixture();
  await expect(
    f
      .make(f.storage, {
        onAdopted: () => {
          throw new Error("subscriber disconnected");
        },
      })
      .reconcile(),
  ).rejects.toThrow("subscriber disconnected");
  await f
    .make(new AgentStorage(join(f.home, "agents"), logger), {
      onAdopted: () => {
        throw new Error("must not republish");
      },
    })
    .reconcile();
  expect(await f.storage.list()).toHaveLength(1);
  expect(await f.workspaces.list()).toHaveLength(1);
});

test("stop aborts read-only discovery and prevents later adoption", async () => {
  const f = await fixture();
  let started!: () => void;
  const listing = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted = false;
  const adoption = f.make(f.storage, {
    listSessions: async ({ signal }) => {
      started();
      return new Promise((_resolve, reject) => {
        signal!.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    },
  });
  adoption.start();
  await listing;
  await adoption.stop();
  expect(aborted).toBe(true);
  expect(await f.storage.list()).toEqual([]);
  expect(await f.workspaces.list()).toEqual([]);
});

test("fresh storage and workspace registries reuse durable placement for a new native session after restart", async () => {
  const f = await fixture();
  await f.make().reconcile();
  const [original] = await f.storage.list();
  f.setSessions([session("native-1", f.cwd), session("native-after-restart", f.cwd)]);
  const storage = new AgentStorage(join(f.home, "agents"), logger);
  const projects = new FileBackedProjectRegistry(join(f.home, "projects.json"), logger);
  const workspaces = new FileBackedWorkspaceRegistry(join(f.home, "workspaces.json"), logger);
  const provisioning = createWorkspaceProvisioningService({
    projectRegistry: projects,
    workspaceRegistry: workspaces,
    logger,
    workspaceGitService: {
      getCheckout: async () => {
        throw new Error("Existing placement must not be recreated");
      },
      getSnapshot: async () => {
        throw new Error("Unexpected git snapshot");
      },
      peekSnapshot: () => null,
    },
  });
  await f.make(storage, { workspaceProvisioning: provisioning }).reconcile();
  expect((await storage.list()).map((record) => record.workspaceId)).toEqual([
    original!.workspaceId,
    original!.workspaceId,
  ]);
  expect((await storage.list())[0]?.id).toBe(original!.id);
  expect(await workspaces.list()).toHaveLength(1);
  expect(await projects.list()).toHaveLength(1);
});

test.each([
  ["projects.json", 0],
  ["workspaces.json", 1],
] as const)(
  "failed %s allocation is never published to cache or reused as durable placement",
  async (name, expectedProjectCount) => {
    const f = await fixture();
    await f.projects.initialize();
    await f.workspaces.initialize();
    await mkdir(join(f.home, name));
    await expect(f.make().reconcile()).rejects.toThrow();
    expect(await f.storage.list()).toEqual([]);
    expect(await f.workspaces.list()).toEqual([]);
    expect(await f.projects.list()).toHaveLength(expectedProjectCount);
    await rm(join(f.home, name), { recursive: true });
    await f.make().reconcile();
    const workspaces = new FileBackedWorkspaceRegistry(join(f.home, "workspaces.json"), logger);
    const projects = new FileBackedProjectRegistry(join(f.home, "projects.json"), logger);
    const [agent] = await new AgentStorage(join(f.home, "agents"), logger).list();
    expect((await workspaces.list()).map((record) => record.workspaceId)).toEqual([
      agent!.workspaceId,
    ]);
    expect(await projects.list()).toHaveLength(1);
  },
);

test("existing adoption recovery rejects orphaned placement", async () => {
  const f = await fixture();
  await f.make().reconcile();
  const [agent] = await f.storage.list();
  await f.workspaces.remove(agent!.workspaceId!);
  await expect(f.make().reconcile()).rejects.toThrow("Workspace not found");
  expect(await f.workspaces.list()).toEqual([]);
  expect(await f.storage.list()).toHaveLength(1);
});

async function seededAlias(archived: boolean) {
  const f = await fixture();
  await f.make().reconcile();
  const [workspace] = await f.workspaces.list();
  const alias = join(f.home, "existing-alias");
  await symlink(f.cwd, alias);
  await f.workspaces.upsert({
    ...workspace!,
    cwd: alias,
    archivedAt: archived ? new Date(cutoff).toISOString() : null,
  });
  f.setSessions([session("next-session", f.cwd)]);
  return { ...f, workspace: workspace! };
}

test("a preexisting active symlink-alias workspace preserves its identity", async () => {
  const f = await seededAlias(false);
  await f.make().reconcile();
  expect((await f.storage.list()).map((record) => record.workspaceId)).toEqual([
    f.workspace.workspaceId,
    f.workspace.workspaceId,
  ]);
  expect((await f.workspaces.list()).map((record) => record.workspaceId)).toEqual([
    f.workspace.workspaceId,
  ]);
});

test("a preexisting archived symlink alias cannot be bypassed through its canonical path", async () => {
  const f = await seededAlias(true);
  await expect(f.make().reconcile()).rejects.toThrow("archived");
  const workspace = f.workspace;
  expect((await f.workspaces.list()).map((record) => record.workspaceId)).toEqual([
    workspace!.workspaceId,
  ]);
});

test("coordinator-named headless roots remain unknown without authoritative TUI enrollment", async () => {
  const f = await fixture();
  await f.make(f.storage, { readEnrollments: async () => [] }).reconcile();
  expect(await f.storage.list()).toEqual([]);
  expect(await f.workspaces.list()).toEqual([]);
});

test("worker reservation wins over TUI enrollment before the first meaningful worker prompt", async () => {
  const f = await fixture();
  const identity = { version: 1 as const, endpoint, sessionId: "native-1", cwd: f.cwd };
  const enrollments = [
    {
      ...identity,
      classification: "coordinator" as const,
      provenance: { producer: "tui", kind: "tui-session" as const, eventId: "switch" },
    },
    {
      ...identity,
      classification: "worker" as const,
      provenance: {
        producer: "launcher",
        kind: "worker-reservation" as const,
        eventId: "before-prompt",
      },
    },
  ];
  f.setSessions([{ ...session("native-1", f.cwd), firstUserMessage: null }]);
  await f.make(f.storage, { readEnrollments: async () => enrollments }).reconcile();
  f.setSessions([session("native-1", f.cwd)]);
  await f.make(f.storage, { readEnrollments: async () => enrollments.slice(0, 1) }).reconcile();
  expect(await f.storage.list()).toEqual([]);
});

test("an invalid row and failing root do not starve later pages or registered roots", async () => {
  const f = await fixture();
  await f.make().reconcile();
  const other = join(f.home, "other"),
    unavailable = join(f.home, "unavailable");
  await mkdir(other);
  await mkdir(unavailable);
  f.config.roots.unshift({ cwd: unavailable });
  f.config.roots.push({ cwd: other });
  const [record] = await f.storage.list();
  await f.storage.upsert({
    ...record!,
    id: "orphan",
    workspaceId: "missing",
    persistence: { ...record!.persistence!, sessionId: "orphan", nativeHandle: "orphan" },
  });
  const rows = [
    session("orphan", f.cwd),
    session("later-page", f.cwd),
    session("later-root", other),
  ];
  f.setSessions(rows);
  await expect(
    f
      .make(f.storage, {
        listSessions: async ({ cwd, cursor }) => {
          if (cwd === unavailable) throw new Error("root unavailable");
          if (cwd === other) return { endpoint, sessions: [rows[2]!] };
          return cursor
            ? { endpoint, sessions: [rows[1]!] }
            : { endpoint, sessions: [rows[0]!], nextCursor: "next" };
        },
      })
      .reconcile(),
  ).rejects.toThrow("root unavailable");
  expect((await f.storage.list()).map((agent) => agent.persistence?.sessionId).sort()).toEqual([
    "later-page",
    "later-root",
    "native-1",
    "orphan",
  ]);
});

test("adoption-state commit failure remains fatal rather than continuing later rows", async () => {
  const f = await fixture();
  await f.make().reconcile();
  const rows = [session("first", f.cwd), session("must-not-follow", f.cwd)];
  f.setSessions(rows);
  await expect(
    f
      .make(f.storage, {
        listSessions: async () => {
          await rm(join(f.home, "adoption.json"));
          await mkdir(join(f.home, "adoption.json"));
          return { endpoint, sessions: rows };
        },
      })
      .reconcile(),
  ).rejects.toThrow("Failed to persist external OpenCode adoption state");
  expect((await f.storage.list()).map((record) => record.persistence?.sessionId).sort()).toEqual([
    "first",
    "native-1",
  ]);
});
