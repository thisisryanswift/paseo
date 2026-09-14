import type { Event, GlobalEvent, OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { Logger } from "pino";

// Adapted from getpaseo/paseo d1b705a0cd91617a5707fae25d80cb0be3057950.
// Keep the acquired, authenticated client and session-owned detach boundary in this fork.
export interface OpenCodeObservationTiming {
  arm(delayMs: number, callback: () => void): () => void;
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}

export const openCodeObservationTiming: OpenCodeObservationTiming = {
  arm(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
  wait(delayMs, signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      timer.unref();
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  },
};

export async function waitForOpenCodeObservation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

interface OpenCodeEventConsumerOptions {
  client: Pick<OpencodeClient, "global">;
  signal: AbortSignal;
  logger: Pick<Logger, "warn" | "debug">;
  timing: OpenCodeObservationTiming;
  onConnected(): void;
  onEvent(event: GlobalEvent): void;
}

export async function consumeOpenCodeEvents(options: OpenCodeEventConsumerOptions): Promise<void> {
  const { client, signal, timing, logger } = options;
  let failures = 0;
  while (!signal.aborted) {
    const request = new AbortController();
    const abort = () => request.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    let cancelWatchdog = () => {};
    let phase = "first-record";
    let delivered = false;
    let connected = false;
    let failure: unknown;
    const armWatchdog = () => {
      cancelWatchdog();
      cancelWatchdog = timing.arm(30_000, () => {
        failure = new Error(`OpenCode event stream ${phase} watchdog expired`);
        request.abort(failure);
      });
    };
    try {
      // Include a stalled HTTP open in the watchdog, not just a stalled iterator.
      armWatchdog();
      const result = await client.global.event({
        signal: request.signal,
        sseMaxRetryAttempts: 0,
        onSseError: (error) => {
          failure = error;
        },
      });
      for await (const event of result.stream) {
        if (signal.aborted || request.signal.aborted) break;
        armWatchdog();
        phase = "stream";
        delivered = true;
        const payload = "payload" in event ? event.payload : (event as Event);
        if (payload.type === "server.connected" && !connected) {
          options.onConnected();
          connected = true;
        } else if (payload.type !== "server.connected") options.onEvent(event);
      }
    } catch (error) {
      failure = error;
    } finally {
      cancelWatchdog();
      signal.removeEventListener("abort", abort);
      request.abort();
    }
    if (signal.aborted) return;
    failures = delivered ? 0 : failures + 1;
    const retryDelayMs = Math.min(100 * 2 ** Math.min(6, Math.max(0, failures - 1)), 5_000);
    logger.warn(
      { err: failure, phase, retryDelayMs },
      "OpenCode event stream interrupted; retrying",
    );
    await timing.wait(retryDelayMs, signal).catch(() => undefined);
  }
}
