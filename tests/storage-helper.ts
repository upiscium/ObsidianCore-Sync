import type { StorageAdapter } from '../src/persistence';

/** In-memory DataAdapter subset for persistence tests; no filesystem access. */
export class MemoryStorageAdapter implements StorageAdapter {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>();
  failNextWrite?: Error;
  failNextBinaryWrite?: Error;
  tornNextWrite?: number;
  tornNextBinaryWrite?: number;
  quotaBytes?: number;
  quotaError = new Error('simulated storage quota exceeded');

  seedText(path: string, value: string): void {
    this.files.set(path, new TextEncoder().encode(value));
  }

  seedBinary(path: string, value: Uint8Array): void {
    this.files.set(path, new Uint8Array(value));
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }

  async read(path: string): Promise<string> {
    const data = this.files.get(path);
    if (!data) throw new Error(`No such in-memory file: ${path}`);
    return new TextDecoder().decode(data);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const data = this.files.get(path);
    if (!data) throw new Error(`No such in-memory file: ${path}`);
    const copy = new Uint8Array(data);
    return copy.buffer;
  }

  async write(path: string, data: string): Promise<void> {
    const bytes = new TextEncoder().encode(data);
    if (this.tornNextWrite !== undefined) {
      const length = this.tornNextWrite;
      this.tornNextWrite = undefined;
      this.checkQuota(path, bytes.subarray(0, length));
      this.files.set(path, bytes.slice(0, length));
      throw new Error('simulated torn text write');
    }
    if (this.failNextWrite) {
      const error = this.failNextWrite;
      this.failNextWrite = undefined;
      throw error;
    }
    this.checkQuota(path, bytes);
    this.files.set(path, new Uint8Array(bytes));
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const bytes = new Uint8Array(data.slice(0));
    if (this.tornNextBinaryWrite !== undefined) {
      const length = this.tornNextBinaryWrite;
      this.tornNextBinaryWrite = undefined;
      this.checkQuota(path, bytes.subarray(0, length));
      this.files.set(path, bytes.slice(0, length));
      throw new Error('simulated torn binary write');
    }
    if (this.failNextBinaryWrite) {
      const error = this.failNextBinaryWrite;
      this.failNextBinaryWrite = undefined;
      throw error;
    }
    this.checkQuota(path, bytes);
    this.files.set(path, bytes);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path}/`;
    const files = [...this.files.keys()].filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'));
    const folders = [...this.directories].filter((folder) => folder.startsWith(prefix) && !folder.slice(prefix.length).includes('/'));
    return { files: files.sort(), folders: folders.sort() };
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  private checkQuota(path: string, next: Uint8Array): void {
    if (this.quotaBytes === undefined) return;
    let total = next.byteLength;
    for (const [existingPath, data] of this.files) {
      if (existingPath !== path) total += data.byteLength;
    }
    if (total > this.quotaBytes) throw this.quotaError;
  }
}
