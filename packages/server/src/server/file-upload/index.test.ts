import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { FileUploadStore } from "./index.js";

const tempDirs: string[] = [];

describe("file uploads", () => {
  beforeEach(() => {
    vi.stubEnv("PASEO_UPLOADS_DIR", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stores uploads in a configured shared directory", async () => {
    const paseoHome = makePaseoHome();
    const uploadsDirectory = join(paseoHome, "shared-uploads");
    vi.stubEnv("PASEO_UPLOADS_DIR", uploadsDirectory);
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      requestId: "req-shared",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 5,
    });

    await uploads.receiveFrame(uploadBegins("req-shared"));
    await uploads.receiveFrame(uploadChunk("req-shared", "hello"));
    const response = await uploads.receiveFrame(uploadEnds("req-shared"));

    const file = response?.payload.file;
    expect(file).not.toBeNull();
    if (!file) {
      throw new Error("expected an uploaded file");
    }
    expect(file.path).toBe(join(uploadsDirectory, file.id, "notes.txt"));
    expect(readFileSync(file.path, "utf8")).toBe("hello");
  });

  it("stores chunked upload bytes and returns an uploaded-file attachment", async () => {
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-upload",
    });
    await expect(uploads.receiveFrame(uploadBegins("req-upload"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-upload", "hello"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-upload", " world"))).resolves.toBeNull();

    const response = await uploads.receiveFrame(uploadEnds("req-upload"));
    expect(response).toMatchObject({
      type: "file.upload.response",
      payload: {
        requestId: "req-upload",
        file: {
          type: "uploaded_file",
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 11,
        },
        error: null,
      },
    });
    const file = response?.payload.file;
    if (!file) {
      throw new Error("expected an uploaded file");
    }
    expect(file.path).toBe(join(paseoHome, "uploads", file.id, "notes.txt"));
    expect(readFileSync(file.path, "utf8")).toBe("hello world");
  });

  it("rejects chunks beyond the declared size and removes the partial file", async () => {
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-overflow",
    });
    await expect(uploads.receiveFrame(uploadBegins("req-overflow"))).resolves.toBeNull();

    await expect(uploads.receiveFrame(uploadChunk("req-overflow", "hello!"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-overflow",
        file: null,
        error: "Upload exceeded declared size: expected 5, received 6.",
      },
    });
    expect(readdirSync(join(paseoHome, "uploads"))).toEqual([]);
  });

  it("preserves chunk order when frames arrive before earlier disk writes finish", async () => {
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-queued",
    });

    const results = await Promise.all([
      uploads.receiveFrame(uploadBegins("req-queued")),
      uploads.receiveFrame(uploadChunk("req-queued", "hello")),
      uploads.receiveFrame(uploadChunk("req-queued", " world")),
      uploads.receiveFrame(uploadEnds("req-queued")),
    ]);

    expect(results.slice(0, 3)).toEqual([null, null, null]);
    const file = results[3]?.payload.file;
    expect(results[3]?.payload.error).toBeNull();
    if (!file) {
      throw new Error("expected an uploaded file");
    }
    expect(readFileSync(file.path, "utf8")).toBe("hello world");
  });

  it("replaces duplicate upload starts without letting the old stale timeout evict the replacement", async () => {
    vi.useFakeTimers();

    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome, staleUploadTimeoutMs: 50 });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "old.txt",
      mimeType: "text/plain",
      size: 3,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-duplicate",
    });
    await expect(uploads.receiveFrame(uploadBegins("req-duplicate"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-duplicate", "old"))).resolves.toBeNull();
    const [oldUploadId] = readdirSync(join(paseoHome, "uploads"));
    if (!oldUploadId) {
      throw new Error("expected the original upload directory");
    }

    await vi.advanceTimersByTimeAsync(25);
    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "new.txt",
      mimeType: "text/plain",
      size: 3,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-duplicate",
    });
    await vi.advanceTimersByTimeAsync(30);

    await expect(uploads.receiveFrame(uploadBegins("req-duplicate"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-duplicate", "new"))).resolves.toBeNull();
    const response = await uploads.receiveFrame(uploadEnds("req-duplicate"));
    expect(response).toMatchObject({
      type: "file.upload.response",
      payload: {
        requestId: "req-duplicate",
        file: {
          type: "uploaded_file",
          fileName: "new.txt",
          mimeType: "text/plain",
          size: 3,
        },
        error: null,
      },
    });
    const file = response?.payload.file;
    if (!file) {
      throw new Error("expected an uploaded file");
    }
    expect(file.id).not.toBe(oldUploadId);
    expect(existsSync(join(paseoHome, "uploads", oldUploadId))).toBe(false);
    expect(readFileSync(file.path, "utf8")).toBe("new");
  });

  it("keeps an active upload alive beyond the initial stale timeout", async () => {
    vi.useFakeTimers();

    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome, staleUploadTimeoutMs: 50 });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-slow-active",
    });

    await vi.advanceTimersByTimeAsync(25);
    await expect(uploads.receiveFrame(uploadBegins("req-slow-active"))).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(30);
    await expect(uploads.receiveFrame(uploadChunk("req-slow-active", "hello"))).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(30);
    await expect(
      uploads.receiveFrame(uploadChunk("req-slow-active", " world")),
    ).resolves.toBeNull();

    const response = await uploads.receiveFrame(uploadEnds("req-slow-active"));
    expect(response).toMatchObject({
      type: "file.upload.response",
      payload: {
        requestId: "req-slow-active",
        file: {
          type: "uploaded_file",
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 11,
        },
        error: null,
      },
    });
    const file = response?.payload.file;
    if (!file) {
      throw new Error("expected an uploaded file");
    }
    expect(readFileSync(file.path, "utf8")).toBe("hello world");
  });

  it("does not remove a directory it failed to claim after an ID collision", async () => {
    const paseoHome = makePaseoHome();
    const uploadsDirectory = join(paseoHome, "uploads");
    const collisionId = "upload_collision";
    const collisionDirectory = join(uploadsDirectory, collisionId);
    const markerPath = join(collisionDirectory, "owned-by-another-process");
    mkdirSync(collisionDirectory, { recursive: true });
    writeFileSync(markerPath, "keep");
    const uploads = new FileUploadStore({
      paseoHome,
      idFactory: () => "collision",
    });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      requestId: "req-collision",
    });

    const response = await uploads.receiveFrame(uploadBegins("req-collision"));

    expect(response?.payload.file).toBeNull();
    expect(response?.payload.error).toContain("EEXIST");
    expect(readFileSync(markerPath, "utf8")).toBe("keep");
  });
});

function makePaseoHome(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "file-upload-test-")));
  tempDirs.push(root);
  return root;
}

function uploadBegins(requestId: string): FileTransferFrame {
  return decodeUploadFrame(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileBegin,
      requestId,
      metadata: {
        mime: "text/plain",
        size: 11,
        encoding: "binary",
        modifiedAt: "2026-05-02T00:00:00.000Z",
        fileName: "notes.txt",
      },
    }),
  );
}

function uploadChunk(requestId: string, text: string): FileTransferFrame {
  return decodeUploadFrame(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileChunk,
      requestId,
      payload: new TextEncoder().encode(text),
    }),
  );
}

function uploadEnds(requestId: string): FileTransferFrame {
  return decodeUploadFrame(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileEnd,
      requestId,
    }),
  );
}

function decodeUploadFrame(bytes: Uint8Array): FileTransferFrame {
  const frame = decodeFileTransferFrame(bytes);
  if (!frame) {
    throw new Error("Expected file transfer frame");
  }
  return frame;
}
