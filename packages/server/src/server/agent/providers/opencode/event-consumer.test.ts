import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { consumeOpenCodeEvents } from "./event-consumer.js";
import { TestOpenCodeClient } from "./test-utils/test-opencode-harness.js";
import {
  ManualObservationTiming,
  flushObservation,
} from "./test-utils/manual-observation-timing.js";

describe("OpenCode event consumer", () => {
  test("retries failed opens with capped exponential backoff and cancels pending retries on detach", async () => {
    const client = new TestOpenCodeClient();
    client.globalEventImplementation = async () => {
      throw new Error("disconnected");
    };
    const timing = new ManualObservationTiming();
    const abort = new AbortController();
    const task = consumeOpenCodeEvents({
      client: client.asSdkClient(),
      signal: abort.signal,
      timing,
      logger: createTestLogger(),
      onConnected() {},
      onEvent() {},
    });
    await flushObservation();
    expect(client.calls.globalEvent).toHaveLength(1);
    for (const [index, delay] of [100, 200, 400, 800, 1600, 3200, 5000, 5000].entries()) {
      await timing.advance(delay - 1);
      expect(client.calls.globalEvent).toHaveLength(index + 1);
      await timing.advance(1);
      expect(client.calls.globalEvent).toHaveLength(index + 2);
    }
    abort.abort();
    await task;
    expect(timing.pendingCount).toBe(0);
  });

  test("a quiet stream expires its watchdog even before the first record, then recovers", async () => {
    const client = new TestOpenCodeClient();
    client.emitConnected = false;
    const timing = new ManualObservationTiming();
    const abort = new AbortController();
    let connections = 0;
    const task = consumeOpenCodeEvents({
      client: client.asSdkClient(),
      signal: abort.signal,
      timing,
      logger: createTestLogger(),
      onConnected() {
        connections += 1;
      },
      onEvent() {},
    });
    await timing.advance(29_999);
    expect(client.calls.globalEvent).toHaveLength(1);
    expect(connections).toBe(0);
    client.emitConnected = true;
    await timing.advance(101);
    expect(client.calls.globalEvent).toHaveLength(2);
    expect(connections).toBe(1);
    await timing.advance(30_100);
    expect(client.calls.globalEvent).toHaveLength(3);
    expect(connections).toBe(2);
    abort.abort();
    await task;
    expect(timing.pendingCount).toBe(0);
  });

  test("watchdog also bounds an SDK open that waits for HTTP headers", async () => {
    const client = new TestOpenCodeClient();
    client.globalEventImplementation = (options) =>
      new Promise((_resolve, reject) => {
        const signal = (options as { signal: AbortSignal }).signal;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const timing = new ManualObservationTiming();
    const abort = new AbortController();
    const task = consumeOpenCodeEvents({
      client: client.asSdkClient(),
      signal: abort.signal,
      timing,
      logger: createTestLogger(),
      onConnected() {},
      onEvent() {},
    });
    await timing.advance(30_100);
    expect(client.calls.globalEvent).toHaveLength(2);
    abort.abort();
    await task;
    expect(timing.pendingCount).toBe(0);
  });
});
