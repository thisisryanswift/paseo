import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { externalOpenCodeSessionKey } from "./external-opencode-types.js";
import { normalizePathForIdentity } from "../../utils/path.js";

/** Trusted W1/W2 producers publish before a worker's first native prompt. */
export const SessionEnrollmentSchema = z
  .object({
    version: z.literal(1),
    endpoint: z.string(),
    sessionId: z.string().min(1),
    cwd: z.string().refine(isAbsolute),
    classification: z.enum(["coordinator", "worker", "excluded"]),
    provenance: z
      .object({
        producer: z.string().min(1),
        kind: z.enum(["tui-session", "worker-reservation", "explicit-exclusion"]),
        eventId: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type SessionEnrollment = z.infer<typeof SessionEnrollmentSchema>;

/** Immutable content-addressed events: concurrent producers cannot overwrite exclusions. */
export async function publishSessionEnrollment(
  directory: string,
  input: SessionEnrollment,
): Promise<void> {
  const record = SessionEnrollmentSchema.parse(input);
  externalOpenCodeSessionKey(record.endpoint, record.sessionId);
  if (record.classification === "coordinator" && record.provenance.kind !== "tui-session") {
    throw new Error("Coordinator enrollment requires an authoritative TUI session event");
  }
  const content = JSON.stringify(record);
  await writeJsonFileAtomic(
    join(directory, `${createHash("sha256").update(content).digest("hex")}.json`),
    record,
  );
}

export async function readSessionEnrollments(directory: string): Promise<SessionEnrollment[]> {
  // Missing/unreadable authority is an error, never permission to guess from agent names.
  const names = await readdir(directory);
  return Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map(async (name) =>
        SessionEnrollmentSchema.parse(JSON.parse(await readFile(join(directory, name), "utf8"))),
      ),
  );
}

export function classifyEnrolledSession(
  records: SessionEnrollment[],
  endpoint: string,
  sessionId: string,
  cwd: string,
): "coordinator" | "worker" | "excluded" | "unknown" {
  const key = externalOpenCodeSessionKey(endpoint, sessionId);
  const matches = records.filter(
    (record) => externalOpenCodeSessionKey(record.endpoint, record.sessionId) === key,
  );
  if (matches.some((record) => record.classification === "excluded")) return "excluded";
  if (matches.some((record) => record.classification === "worker")) return "worker";
  if (matches.some((record) => normalizePathForIdentity(record.cwd) !== cwd)) return "excluded";
  return matches.some(
    (record) => record.classification === "coordinator" && record.provenance.kind === "tui-session",
  )
    ? "coordinator"
    : "unknown";
}
