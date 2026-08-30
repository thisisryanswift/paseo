import { describe, expect, test } from "vitest";

import { ExternalOpenCodeServerManager } from "./external-server-manager.js";

describe("ExternalOpenCodeServerManager", () => {
  test("normalizes the configured URL and never owns its lifecycle", async () => {
    const manager = new ExternalOpenCodeServerManager("https://reef.example.test:8443/base///");

    const current = await manager.acquireCurrent();
    const rotated = await manager.acquireNew();
    const dedicated = await manager.acquireDedicated({ FOO: "bar" });

    expect(current.server).toEqual({
      port: 8443,
      url: "https://reef.example.test:8443/base",
    });
    expect(rotated.server).toEqual(current.server);
    expect(dedicated.server).toEqual(current.server);
    expect(manager.acquireExisting("https://reef.example.test:8443/base/")?.server).toEqual(
      current.server,
    );
    expect(manager.acquireExisting("https://other.example.test:8443/base")).toBeNull();

    await current.release();
    await rotated.release();
    await dedicated.release();
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });

  test("uses the protocol default port", async () => {
    const http = await new ExternalOpenCodeServerManager(
      "http://reef.example.test",
    ).acquireCurrent();
    const https = await new ExternalOpenCodeServerManager(
      "https://reef.example.test",
    ).acquireCurrent();

    expect(http.server.port).toBe(80);
    expect(https.server.port).toBe(443);
    await http.release();
    await https.release();
  });

  test("rejects an already-aborted acquisition", async () => {
    const manager = new ExternalOpenCodeServerManager("https://reef.example.test");
    const controller = new AbortController();
    controller.abort(new Error("refresh canceled"));

    await expect(manager.acquireCurrent(controller.signal)).rejects.toThrow("refresh canceled");
    await expect(manager.acquireNew(controller.signal)).rejects.toThrow("refresh canceled");
  });
});
