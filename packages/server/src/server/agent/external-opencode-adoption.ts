import { v5 as uuidv5 } from "uuid";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { normalizePathForIdentity } from "../../utils/path.js";
import type { WorkspaceProvisioningService } from "../session/workspace-provisioning/workspace-provisioning-service.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import {
  classifyEnrolledSession,
  readSessionEnrollments,
  type SessionEnrollment,
} from "./session-enrollment.js";
import {
  externalOpenCodeSessionKey,
  type ExternalOpenCodeAdoptionConfig,
  type ExternalOpenCodeSessionMetadata,
  type ExternalOpenCodeSessionPage,
  type ListExternalOpenCodeSessionsInput,
} from "./external-opencode-types.js";

const StateSchema = z.object({
  cutoffs: z.record(z.string(), z.number()),
  sessions: z.record(
    z.string(),
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("adopted"),
        agentId: z.string(),
        cwd: z.string(),
        messageId: z.string(),
        agentName: z.string(),
      }),
      z.object({ kind: z.literal("excluded"), reason: z.string() }),
    ]),
  ),
});
type AdoptionState = z.infer<typeof StateSchema>;
type AdoptionRoot = ExternalOpenCodeAdoptionConfig["roots"][number];

interface AdoptionDependencies {
  config: ExternalOpenCodeAdoptionConfig;
  endpoint: string;
  statePath: string;
  agentStorage: AgentStorage;
  workspaceProvisioning: Pick<WorkspaceProvisioningService, "runInImportWorkspace">;
  listSessions(input: ListExternalOpenCodeSessionsInput): Promise<ExternalOpenCodeSessionPage>;
  onAdopted(record: StoredAgentRecord): void;
  logger: Logger;
  readEnrollments?: () => Promise<SessionEnrollment[]>;
}

class AdoptionStatePersistenceError extends Error {}

interface OptionalAdoptionDependencies extends Omit<AdoptionDependencies, "config" | "endpoint"> {
  config?: ExternalOpenCodeAdoptionConfig;
  endpoint?: string;
}

export function createExternalOpenCodeAdoption(
  deps: OptionalAdoptionDependencies,
): ExternalOpenCodeAdoption | null {
  if (!deps.config?.enabled) return null;
  if (!deps.endpoint)
    throw new Error("External OpenCode adoption requires agents.providers.opencode.serverUrl");
  return new ExternalOpenCodeAdoption({ ...deps, config: deps.config, endpoint: deps.endpoint });
}

/** One daemon owns the state file (the normal PASEO_HOME pid lock still applies). */
export class ExternalOpenCodeAdoption {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private stopped = true;

  constructor(private readonly deps: AdoptionDependencies) {}

  start(): void {
    if (!this.deps.config.enabled || !this.stopped) return;
    this.stopped = false;
    const poll = async () => {
      try {
        await this.reconcile();
      } catch (error) {
        this.deps.logger.warn({ err: error }, "External OpenCode adoption failed; will retry");
      }
      if (!this.stopped) {
        this.timer = setTimeout(poll, this.deps.config.pollIntervalMs);
        this.timer.unref();
      }
    };
    void poll();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
    await this.running?.catch(() => undefined);
  }

  reconcile(): Promise<void> {
    if (!this.deps.config.enabled) return Promise.resolve();
    if (this.running) return this.running;
    this.controller = new AbortController();
    this.running = this.deps.agentStorage
      .serializeProviderSessionMutation("external-opencode", () =>
        this.reconcileNow(this.controller!.signal),
      )
      .finally(() => {
        this.running = null;
        this.controller = null;
      });
    return this.running;
  }

  private async reconcileNow(signal: AbortSignal): Promise<void> {
    const { config, endpoint, statePath } = this.deps;
    const endpointKey = externalOpenCodeSessionKey(endpoint, "");
    let state: z.infer<typeof StateSchema>;
    try {
      state = StateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = { cutoffs: {}, sessions: {} };
    }
    const cutoff = Math.max(Date.parse(config.activatedAt), state.cutoffs[endpointKey] ?? 0);
    state.cutoffs[endpointKey] = cutoff;
    await this.persistState(state);
    for (const sessionId of config.excludedSessionIds) {
      await this.exclude(
        state,
        externalOpenCodeSessionKey(endpoint, sessionId),
        "explicit exclusion",
      );
    }

    // Always revisit the fixed activation window. Empty sessions can become meaningful later,
    // and a TUI can create/switch actual IDs long after wrapper startup. No advancing watermark.
    const failures: Error[] = [];
    for (const root of config.roots) {
      try {
        await this.reconcileRoot(root, cutoff, endpointKey, state, signal, failures);
      } catch (error) {
        this.collectScopedFailure(error, `root ${root.cwd}`, signal, failures);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, failures.map((error) => error.message).join("; "));
  }

  private async reconcileRoot(
    root: AdoptionRoot,
    cutoff: number,
    endpointKey: string,
    state: AdoptionState,
    signal: AbortSignal,
    failures: Error[],
  ): Promise<void> {
    const cwd = normalizePathForIdentity(await realpath(root.cwd));
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let pageNumber = 0; ; pageNumber++) {
      signal.throwIfAborted();
      if (pageNumber >= 1000) throw new Error("External OpenCode discovery page limit exceeded");
      const page = await this.deps.listSessions({
        cwd,
        createdAfter: cutoff,
        cursor,
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      if (externalOpenCodeSessionKey(page.endpoint, "") !== endpointKey) {
        throw new Error("External OpenCode discovery endpoint changed");
      }
      for (const session of page.sessions) {
        signal.throwIfAborted();
        if (belongsToActivationWindow(session, cwd, cutoff)) {
          try {
            await this.reconcileSession(session, { ...root, cwd }, state);
          } catch (error) {
            this.collectScopedFailure(error, `session ${session.sessionId}`, signal, failures);
          }
        }
      }
      cursor = page.nextCursor;
      if (!cursor) break;
      if (cursors.has(cursor))
        throw new Error("External OpenCode discovery cursor did not advance");
      cursors.add(cursor);
    }
  }

  private collectScopedFailure(
    error: unknown,
    scope: string,
    signal: AbortSignal,
    failures: Error[],
  ): void {
    signal.throwIfAborted();
    if (error instanceof AdoptionStatePersistenceError) throw error;
    const failure = new Error(
      `${scope}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
    failures.push(failure);
    this.deps.logger.warn({ err: failure, scope }, "External OpenCode adoption scope failed");
  }

  private async persistState(state: AdoptionState): Promise<void> {
    try {
      await writeJsonFileAtomic(this.deps.statePath, state);
    } catch (error) {
      throw new AdoptionStatePersistenceError(
        "Failed to persist external OpenCode adoption state",
        { cause: error },
      );
    }
  }

  private async exclude(state: AdoptionState, key: string, reason: string): Promise<void> {
    state.sessions[key] = { kind: "excluded", reason };
    await this.persistState(state);
  }

  private async reconcileSession(
    session: ExternalOpenCodeSessionMetadata,
    root: AdoptionRoot,
    state: AdoptionState,
  ): Promise<void> {
    const { config, endpoint, agentStorage } = this.deps;
    const key = externalOpenCodeSessionKey(endpoint, session.sessionId);
    if (state.sessions[key]?.kind === "excluded") return;
    const exclusion = classifyExclusion(session, config);
    if (exclusion) return this.exclude(state, key, exclusion);
    const enrollments = await this.readEnrollments();
    const classification = classifyEnrolledSession(
      enrollments,
      endpoint,
      session.sessionId,
      root.cwd,
    );
    if (classification === "worker" || classification === "excluded")
      return this.exclude(state, key, classification);
    const eligible = isEligibleCoordinator(session, config, classification);
    if (!eligible || !session.firstUserMessage) return;

    // Identity precedes placement. Restart after either write reuses the stored owner.
    const records = await agentStorage.listByProviderSession(
      "opencode",
      session.sessionId,
      endpoint,
    );
    if (records.length > 1)
      throw new Error(`Ambiguous external OpenCode owner: ${session.sessionId}`);
    const existing = records[0];
    if (existing?.archivedAt) return this.exclude(state, key, "Paseo archive");
    if (existing && normalizePathForIdentity(existing.cwd) !== root.cwd)
      throw new Error(`External OpenCode cwd changed: ${session.sessionId}`);
    if (!existing && state.sessions[key]?.kind === "adopted")
      return this.exclude(state, key, "Paseo record removed");
    if (existing) {
      if (!existing.workspaceId) throw new Error("Existing adoption has no workspace mapping");
      await this.deps.workspaceProvisioning.runInImportWorkspace(
        { cwd: root.cwd, requestedWorkspaceId: existing.workspaceId, reuseExisting: true },
        async () => undefined,
      );
    }
    const record = existing ?? (await this.createRecord(session, root));
    state.sessions[key] = {
      kind: "adopted",
      agentId: record.id,
      cwd: root.cwd,
      messageId: session.firstUserMessage.id,
      agentName: session.firstUserMessage.agent,
    };
    await this.persistState(state);
    if (!existing) this.deps.onAdopted(record);
  }

  private async readEnrollments(): Promise<SessionEnrollment[]> {
    if (this.deps.readEnrollments) return this.deps.readEnrollments();
    if (
      this.deps.config.classificationMode === "reserved-role-pilot" &&
      !this.deps.config.enrollmentDirectory
    )
      return [];
    if (!this.deps.config.enrollmentDirectory)
      throw new Error("External OpenCode adoption requires an authoritative enrollmentDirectory");
    return readSessionEnrollments(this.deps.config.enrollmentDirectory);
  }

  private async createRecord(
    session: ExternalOpenCodeSessionMetadata,
    root: AdoptionRoot,
  ): Promise<StoredAgentRecord> {
    const { agentStorage, endpoint, workspaceProvisioning } = this.deps;
    const legacy = await agentStorage.listByProviderSession("opencode", session.sessionId);
    if (legacy.some((candidate) => !candidate.persistence?.metadata?.openCodeServerUrl)) {
      throw new Error(`External OpenCode owner lacks endpoint identity: ${session.sessionId}`);
    }
    const key = externalOpenCodeSessionKey(endpoint, session.sessionId);
    const placement = await workspaceProvisioning.runInImportWorkspace(
      { cwd: root.cwd, requestedWorkspaceId: root.workspaceId, reuseExisting: true },
      async (workspace) => {
        const config = { modeId: session.modeId, model: session.model };
        const record: StoredAgentRecord = {
          id: uuidv5(key, uuidv5.URL),
          provider: "opencode",
          cwd: root.cwd,
          workspaceId: workspace.workspaceId,
          createdAt: new Date(session.createdAt).toISOString(),
          updatedAt: new Date(session.updatedAt).toISOString(),
          lastActivityAt: new Date(session.updatedAt).toISOString(),
          title: session.title,
          labels: {},
          lastStatus: "closed",
          lastModeId: session.modeId,
          config,
          persistence: {
            provider: "opencode",
            sessionId: session.sessionId,
            nativeHandle: session.sessionId,
            metadata: {
              ...config,
              cwd: root.cwd,
              openCodeServerUrl: externalOpenCodeSessionKey(endpoint, "").slice(0, -1),
              ...(this.deps.config.classificationMode === "reserved-role-pilot"
                ? { externalOpenCodePilot: true }
                : {}),
            },
          },
        };
        await agentStorage.upsert(record);
        return record;
      },
    );
    return placement.value;
  }
}

function belongsToActivationWindow(
  session: ExternalOpenCodeSessionMetadata,
  cwd: string,
  cutoff: number,
): boolean {
  return (
    isAbsolute(session.cwd) &&
    normalizePathForIdentity(session.cwd) === cwd &&
    Number.isFinite(session.createdAt) &&
    session.createdAt > cutoff
  );
}

function classifyExclusion(
  session: ExternalOpenCodeSessionMetadata,
  config: ExternalOpenCodeAdoptionConfig,
): string | null {
  if (session.archivedAt !== null) return "native archive";
  if (session.parentId) return "native child";
  const roles = [...session.agentNames, session.firstUserMessage?.agent, session.modeId];
  if (roles.some((name) => name && config.workerAgentNames.includes(name))) return "worker agent";
  return null;
}

function isReservedRoleCoordinator(
  session: ExternalOpenCodeSessionMetadata,
  config: ExternalOpenCodeAdoptionConfig,
): boolean {
  if (!session.firstUserMessage) return false;
  const roles = [...session.agentNames, session.firstUserMessage.agent];
  if (session.modeId !== undefined) roles.push(session.modeId);
  return roles.every((role) => config.coordinatorAgentNames.includes(role));
}

function isEligibleCoordinator(
  session: ExternalOpenCodeSessionMetadata,
  config: ExternalOpenCodeAdoptionConfig,
  classification: ReturnType<typeof classifyEnrolledSession>,
): boolean {
  return config.classificationMode === "reserved-role-pilot"
    ? isReservedRoleCoordinator(session, config)
    : classification === "coordinator";
}
