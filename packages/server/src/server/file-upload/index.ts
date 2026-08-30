import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";

import { FileTransferOpcode, type FileTransferFrame } from "@getpaseo/protocol/binary-frames/index";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { FileUploadRequest, FileUploadResponse } from "../messages.js";

interface FileUploadStoreOptions {
  paseoHome: string;
  uploadsDirectory?: string;
  staleUploadTimeoutMs?: number;
  idFactory?: () => string;
}

interface PendingUpload {
  requestId: string;
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  path: string;
  receivedBytes: number;
  started: boolean;
  ownsDirectory: boolean;
  staleTimeout: ReturnType<typeof setTimeout>;
  queue: Promise<void>;
}

export class FileUploadStore {
  private static readonly defaultStaleUploadTimeoutMs = 10 * 60 * 1000;

  private readonly uploadsDirectory: string;
  private readonly staleUploadTimeoutMs: number;
  private readonly idFactory: () => string;
  private readonly pending = new Map<string, PendingUpload>();

  constructor(options: FileUploadStoreOptions) {
    const configuredUploadsDirectory = options.uploadsDirectory ?? process.env.PASEO_UPLOADS_DIR;
    this.uploadsDirectory = resolve(
      configuredUploadsDirectory || join(options.paseoHome, "uploads"),
    );
    this.staleUploadTimeoutMs =
      options.staleUploadTimeoutMs ?? FileUploadStore.defaultStaleUploadTimeoutMs;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  beginUpload(request: FileUploadRequest): void {
    const existingUpload = this.pending.get(request.requestId);
    if (existingUpload) {
      this.clearPendingUpload(existingUpload);
      void existingUpload.queue.then(() => this.removeUploadDirectory(existingUpload));
    }

    const fileName = sanitizeFileName(request.fileName);
    const id = `upload_${this.idFactory()}`;
    const uploadDir = join(this.uploadsDirectory, id);
    const upload: PendingUpload = {
      requestId: request.requestId,
      id,
      fileName,
      mimeType: request.mimeType,
      size: request.size,
      path: join(uploadDir, fileName),
      receivedBytes: 0,
      started: false,
      ownsDirectory: false,
      staleTimeout: this.createStaleUploadTimeout(request.requestId),
      queue: Promise.resolve(),
    };
    this.pending.set(request.requestId, upload);
  }

  async receiveFrame(frame: FileTransferFrame): Promise<FileUploadResponse | null> {
    const upload = this.pending.get(frame.requestId);
    if (!upload) {
      return null;
    }
    this.refreshStaleUploadTimeout(upload);

    const operation = upload.queue.then(() => this.applyFrame(upload, frame));
    upload.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async applyFrame(
    upload: PendingUpload,
    frame: FileTransferFrame,
  ): Promise<FileUploadResponse | null> {
    if (this.pending.get(upload.requestId) !== upload) {
      return null;
    }

    try {
      if (frame.opcode === FileTransferOpcode.FileBegin) {
        await this.startWriting(upload);
        return null;
      }
      if (frame.opcode === FileTransferOpcode.FileChunk) {
        await this.writeChunk(upload, frame.payload);
        return null;
      }
      return await this.completeUpload(upload);
    } catch (error) {
      await this.removeFailedUpload(upload);
      return buildUploadResponse(upload, getErrorMessage(error));
    }
  }

  private async startWriting(upload: PendingUpload): Promise<void> {
    await mkdir(this.uploadsDirectory, { recursive: true });
    await mkdir(join(this.uploadsDirectory, upload.id));
    upload.ownsDirectory = true;
    await writeFile(upload.path, new Uint8Array(), { flag: "wx" });
    upload.started = true;
  }

  private async writeChunk(upload: PendingUpload, bytes: Uint8Array): Promise<void> {
    if (!upload.started) {
      throw new Error("Upload chunks arrived before file begin.");
    }
    const nextReceivedBytes = upload.receivedBytes + bytes.byteLength;
    if (nextReceivedBytes > upload.size) {
      throw new Error(
        `Upload exceeded declared size: expected ${upload.size}, received ${nextReceivedBytes}.`,
      );
    }
    await appendFile(upload.path, bytes);
    upload.receivedBytes += bytes.byteLength;
  }

  private async completeUpload(upload: PendingUpload): Promise<FileUploadResponse> {
    this.clearPendingUpload(upload);
    if (upload.receivedBytes !== upload.size) {
      await this.removeUploadDirectory(upload);
      return buildUploadResponse(
        upload,
        `Upload size mismatch: expected ${upload.size}, received ${upload.receivedBytes}.`,
      );
    }
    return buildUploadResponse(upload, null);
  }

  private createStaleUploadTimeout(requestId: string): ReturnType<typeof setTimeout> {
    const timeout = setTimeout(() => {
      this.expireStaleUpload(requestId);
    }, this.staleUploadTimeoutMs);
    timeout.unref?.();
    return timeout;
  }

  private refreshStaleUploadTimeout(upload: PendingUpload): void {
    clearTimeout(upload.staleTimeout);
    upload.staleTimeout = this.createStaleUploadTimeout(upload.requestId);
  }

  private expireStaleUpload(requestId: string): void {
    const upload = this.pending.get(requestId);
    if (!upload) {
      return;
    }
    this.clearPendingUpload(upload);
    const cleanup = upload.queue.then(
      () => this.removeUploadDirectory(upload),
      () => this.removeUploadDirectory(upload),
    );
    upload.queue = cleanup.then(
      () => undefined,
      () => undefined,
    );
  }

  private clearPendingUpload(upload: PendingUpload): void {
    clearTimeout(upload.staleTimeout);
    if (this.pending.get(upload.requestId) === upload) {
      this.pending.delete(upload.requestId);
    }
  }

  private async removeFailedUpload(upload: PendingUpload): Promise<void> {
    this.clearPendingUpload(upload);
    await this.removeUploadDirectory(upload);
  }

  private async removeUploadDirectory(upload: PendingUpload): Promise<void> {
    if (!upload.ownsDirectory) {
      return;
    }
    upload.ownsDirectory = false;
    await rm(join(this.uploadsDirectory, upload.id), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

function buildUploadResponse(upload: PendingUpload, error: string | null): FileUploadResponse {
  return {
    type: "file.upload.response",
    payload: {
      requestId: upload.requestId,
      file: error
        ? null
        : {
            type: "uploaded_file",
            id: upload.id,
            fileName: upload.fileName,
            mimeType: upload.mimeType,
            size: upload.size,
            path: upload.path,
          },
      error,
    },
  };
}

function sanitizeFileName(value: string): string {
  const name = basename(value)
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .trim();
  return name.length > 0 && name !== "." && name !== ".." ? name : "upload";
}
