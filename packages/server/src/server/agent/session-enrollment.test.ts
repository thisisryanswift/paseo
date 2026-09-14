import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  publishSessionEnrollment,
  readSessionEnrollments,
  classifyEnrolledSession,
  type SessionEnrollment,
} from "./session-enrollment.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { force: true, recursive: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "enrollment-"));
  homes.push(dir);
  return dir;
}
const coordinator: SessionEnrollment = {
  version: 1,
  endpoint: "http://test:4096",
  sessionId: "native-id",
  cwd: "/workspace",
  classification: "coordinator",
  provenance: { producer: "tui-hook", kind: "tui-session", eventId: "session-selected-native-id" },
};

test("concurrent immutable enrollment and prelaunch worker reservation cannot lose the exclusion", async () => {
  const dir = await fixture();
  const worker: SessionEnrollment = {
    ...coordinator,
    classification: "worker",
    provenance: {
      producer: "launcher",
      kind: "worker-reservation",
      eventId: "reserved-before-prompt",
    },
  };
  await Promise.all([
    publishSessionEnrollment(dir, coordinator),
    publishSessionEnrollment(dir, worker),
  ]);
  await publishSessionEnrollment(dir, coordinator);
  const records = await readSessionEnrollments(dir);
  expect(records).toHaveLength(2);
  expect(
    classifyEnrolledSession(records, coordinator.endpoint, coordinator.sessionId, coordinator.cwd),
  ).toBe("worker");
  expect(
    classifyEnrolledSession(records, "http://other:4096", coordinator.sessionId, coordinator.cwd),
  ).toBe("unknown");
});

test("coordinator identity requires TUI provenance; corrupt or missing authority never becomes an empty successful list", async () => {
  const dir = await fixture();
  await expect(
    publishSessionEnrollment(dir, {
      ...coordinator,
      provenance: { ...coordinator.provenance, kind: "worker-reservation" },
    }),
  ).rejects.toThrow("TUI");
  expect(
    classifyEnrolledSession([], coordinator.endpoint, coordinator.sessionId, coordinator.cwd),
  ).toBe("unknown");
  await expect(readSessionEnrollments(join(dir, "missing"))).rejects.toThrow();
  await writeFile(join(dir, "corrupt.json"), "{broken");
  await expect(readSessionEnrollments(dir)).rejects.toThrow();
});
