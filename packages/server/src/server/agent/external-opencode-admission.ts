import { AgentTurnAdmissionError } from "./agent-sdk-types.js";

interface SessionIdentity {
  provider: string;
  persistence?: { metadata?: Record<string, unknown> } | null;
  config?: { externalOpenCodePilot?: boolean };
  lifecycle?: string;
  activeTurnId?: string | null;
}

export function isExternalOpenCodeSession(session: SessionIdentity | null): boolean {
  // The adapter's endpoint marker also survives custom provider aliases extending OpenCode.
  return typeof session?.persistence?.metadata?.openCodeServerUrl === "string";
}

export function isExternalOpenCodePilot(session: SessionIdentity | null): boolean {
  return (
    isExternalOpenCodeSession(session) &&
    (session?.config?.externalOpenCodePilot === true ||
      session?.persistence?.metadata?.externalOpenCodePilot === true)
  );
}

export class ExternalOpenCodeBusyError extends AgentTurnAdmissionError {
  constructor() {
    super(
      "not_sent",
      "OpenCode is busy. Wait for the current turn to finish or use Stop explicitly, then send again. The pilot does not queue or implicitly interrupt ordinary input.",
    );
    this.name = "ExternalOpenCodeBusyError";
  }
}

/** Local observation only; the final provider check still races independent native writers. */
export function assertExternalOpenCodeSendAllowed(
  session: SessionIdentity | null,
  busy = false,
): void {
  if (
    isExternalOpenCodePilot(session) &&
    (busy || session?.lifecycle === "running" || session?.activeTurnId)
  )
    throw new ExternalOpenCodeBusyError();
}
