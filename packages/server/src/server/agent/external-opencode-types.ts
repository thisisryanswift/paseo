import { isAbsolute } from "node:path";
import { z } from "zod";

/** Read-only provider port. Rows must come from native IDs, never inferred titles. */
export interface ExternalOpenCodeSessionMetadata {
  sessionId: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  parentId: string | null;
  title: string | null;
  modeId?: string;
  model?: string;
  agentNames: string[];
  /** First meaningful, nonsynthetic user message; null for empty/system-only sessions. */
  firstUserMessage: { id: string; agent: string } | null;
}

export interface ListExternalOpenCodeSessionsInput {
  cwd: string;
  createdAfter: number;
  cursor?: string;
  signal?: AbortSignal;
}

export interface ExternalOpenCodeSessionPage {
  endpoint: string;
  sessions: ExternalOpenCodeSessionMetadata[];
  nextCursor?: string;
}

const AbsolutePathSchema = z.string().refine(isAbsolute, "Expected an absolute path");

export const ExternalOpenCodeAdoptionConfigSchema = z
  .object({
    enrollmentDirectory: AbsolutePathSchema.optional(),
    classificationMode: z
      .enum(["file-enrollment", "reserved-role-pilot"])
      .default("file-enrollment"),
    enabled: z.boolean().default(false),
    // Required even on restart. Never move this backwards to backfill old sessions.
    activatedAt: z.iso.datetime(),
    roots: z.array(
      z.object({ cwd: AbsolutePathSchema, workspaceId: z.string().optional() }).strict(),
    ),
    // Positive names are used only by the explicit trusted-workflow pilot, not as human provenance.
    coordinatorAgentNames: z.array(z.string().min(1)).default([]),
    workerAgentNames: z.array(z.string().min(1)).default([]),
    excludedSessionIds: z.array(z.string().min(1)).default([]),
    pollIntervalMs: z.number().int().min(1000).max(2_147_483_647).default(15_000),
  })
  .strict()
  .refine(
    (config) =>
      config.classificationMode !== "reserved-role-pilot" ||
      (config.coordinatorAgentNames.length > 0 &&
        config.workerAgentNames.length > 0 &&
        !config.coordinatorAgentNames.some((name) => config.workerAgentNames.includes(name))),
    "Reserved-role pilot requires nonempty, disjoint coordinator and worker role lists",
  );

export type ExternalOpenCodeAdoptionConfig = z.infer<typeof ExternalOpenCodeAdoptionConfigSchema>;

export function externalOpenCodeSessionKey(endpoint: string, sessionId: string): string {
  const url = new URL(endpoint);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Expected an external OpenCode HTTP(S) endpoint without credentials, query or fragment",
    );
  }
  return `${url.href.replace(/\/+$/, "")}\0${sessionId}`;
}
