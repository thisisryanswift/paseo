import type { OpenCodeServerAcquisition, OpenCodeServerManagerLike } from "./server-manager.js";

export function normalizeOpenCodeServerUrl(serverUrl: string): string {
  const parsed = new URL(serverUrl);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

export class ExternalOpenCodeServerManager implements OpenCodeServerManagerLike {
  private readonly server: { port: number; url: string };

  constructor(serverUrl: string) {
    const url = normalizeOpenCodeServerUrl(serverUrl);
    const parsed = new URL(url);
    let port = Number(parsed.port);
    if (!port) {
      port = parsed.protocol === "https:" ? 443 : 80;
    }
    this.server = {
      port,
      url,
    };
  }

  async acquireCurrent(signal?: AbortSignal): Promise<OpenCodeServerAcquisition> {
    signal?.throwIfAborted();
    return this.acquire();
  }

  async acquireNew(signal?: AbortSignal): Promise<OpenCodeServerAcquisition> {
    signal?.throwIfAborted();
    return this.acquire();
  }

  async acquireDedicated(_env: Record<string, string>): Promise<OpenCodeServerAcquisition> {
    return this.acquire();
  }

  acquireExisting(url: string): OpenCodeServerAcquisition | null {
    return normalizeOpenCodeServerUrl(url) === this.server.url ? this.acquire() : null;
  }

  async shutdown(): Promise<void> {}

  private acquire(): OpenCodeServerAcquisition {
    return {
      server: this.server,
      release: async () => {},
    };
  }
}
