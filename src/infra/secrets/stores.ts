import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { SecretStore } from "../../app/ports.ts";

export const KEYCHAIN_SERVICE = "yandex-metrika-mcp";

export class SecretStoreUnavailableError extends Error {
  override readonly name = "SecretStoreUnavailableError";
}

interface KeyringEntry {
  setPassword(password: string): Promise<void>;
  getPassword(): Promise<string | null>;
  deletePassword(): Promise<boolean>;
}

type EntryConstructor = new (service: string, account: string) => KeyringEntry;

/** macOS Keychain, Windows Credential Manager or Linux Secret Service via @napi-rs/keyring. */
export class KeychainStore implements SecretStore {
  readonly kind = "keychain";
  private readonly _Entry: EntryConstructor;

  private constructor(Entry: EntryConstructor) {
    this._Entry = Entry;
  }

  /** Loads the native module and checks that the OS store answers; throws when it does not. */
  static async open(): Promise<KeychainStore> {
    let Entry: EntryConstructor;
    try {
      const mod = (await import("@napi-rs/keyring")) as unknown as { AsyncEntry: EntryConstructor };
      Entry = mod.AsyncEntry;
    } catch {
      throw new SecretStoreUnavailableError(
        "The OS credential store module could not be loaded on this platform.",
      );
    }
    const store = new KeychainStore(Entry);
    try {
      await store.get("__probe__");
    } catch {
      throw new SecretStoreUnavailableError(
        "The OS credential store is not available (for example, no Secret Service on a headless Linux).",
      );
    }
    return store;
  }

  async get(key: string): Promise<string | null> {
    return new this._Entry(KEYCHAIN_SERVICE, key).getPassword();
  }

  async set(key: string, value: string): Promise<void> {
    await new this._Entry(KEYCHAIN_SERVICE, key).setPassword(value);
  }

  async delete(key: string): Promise<void> {
    await new this._Entry(KEYCHAIN_SERVICE, key).deletePassword().catch(() => false);
  }
}

/**
 * Unencrypted JSON file readable only by the current user. Used only when the
 * user opts in explicitly (YM_MCP_SECRET_STORE=file), never as a silent fallback.
 */
export class FileSecretStore implements SecretStore {
  readonly kind = "file";
  private readonly _file: string;

  constructor(file: string) {
    this._file = file;
  }

  private _read(): Record<string, string> {
    if (!existsSync(this._file)) return {};
    return JSON.parse(readFileSync(this._file, "utf8")) as Record<string, string>;
  }

  private _write(data: Record<string, string>): void {
    const tmp = `${this._file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this._file);
  }

  async get(key: string): Promise<string | null> {
    return this._read()[key] ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this._write({ ...this._read(), [key]: value });
  }

  async delete(key: string): Promise<void> {
    const data = this._read();
    delete data[key];
    this._write(data);
  }
}

export class MemorySecretStore implements SecretStore {
  readonly kind = "memory";
  private readonly _data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this._data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this._data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this._data.delete(key);
  }
}

export type SecretStoreChoice = "auto" | "keychain" | "file";

/** auto = keychain; a missing keychain is reported, not silently replaced by a file. */
export async function openSecretStore(
  choice: SecretStoreChoice,
  file: string,
): Promise<SecretStore> {
  if (choice === "file") return new FileSecretStore(file);
  return KeychainStore.open();
}
