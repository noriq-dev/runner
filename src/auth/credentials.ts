import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalServer } from "./oauth.js";

export const DEFAULT_CREDENTIALS_PATH = join(
  homedir(),
  ".noriq",
  "credentials.json",
);

export interface StoredCredential {
  server: string;
  clientId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scope: string | null;
  generation: number;
  updatedAt: string;
}

interface CredentialStore {
  version: 1;
  servers: Record<string, StoredCredential>;
}

const emptyStore = (): CredentialStore => ({ version: 1, servers: {} });

function parseStore(raw: string): CredentialStore {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (value.version === 1 && value.servers && typeof value.servers === "object")
    return value as unknown as CredentialStore;
  if (
    typeof value.server === "string" &&
    typeof value.accessToken === "string"
  ) {
    const server = canonicalServer(value.server);
    return {
      version: 1,
      servers: {
        [server]: {
          server,
          clientId: String(value.clientId ?? ""),
          accessToken: value.accessToken,
          refreshToken:
            typeof value.refreshToken === "string" ? value.refreshToken : null,
          expiresAt:
            typeof value.expiresAt === "string" ? value.expiresAt : null,
          scope: typeof value.scope === "string" ? value.scope : null,
          generation: 1,
          updatedAt: new Date(0).toISOString(),
        },
      },
    };
  }
  throw new Error("unsupported Noriq credential-store format");
}

async function readStore(path: string): Promise<CredentialStore> {
  try {
    return parseStore(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeAtomic(
  path: string,
  value: CredentialStore,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    if (process.platform !== "win32") {
      await chmod(path, 0o600);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(
        `${process.pid}\n${new Date().toISOString()}\n`,
        "utf8",
      );
      await handle.close();
      return async () => {
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const age = Date.now() - (await stat(lockPath)).mtimeMs;
        if (age > 120_000) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {}
      if (Date.now() >= deadline)
        throw new Error(`timed out waiting for credential lock ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export async function loadCredential(
  server: string,
  path = DEFAULT_CREDENTIALS_PATH,
): Promise<StoredCredential | null> {
  const store = await readStore(path);
  return store.servers[canonicalServer(server)] ?? null;
}

export async function updateCredential(
  server: string,
  update: (
    current: StoredCredential | null,
  ) => Promise<StoredCredential> | StoredCredential,
  path = DEFAULT_CREDENTIALS_PATH,
): Promise<StoredCredential> {
  const release = await acquireLock(path);
  try {
    const store = await readStore(path);
    const key = canonicalServer(server);
    const next = await update(store.servers[key] ?? null);
    store.servers[key] = next;
    await writeAtomic(path, store);
    return next;
  } finally {
    await release();
  }
}

export function expiryFrom(expiresInSeconds: number, now = Date.now()): string {
  return new Date(now + expiresInSeconds * 1_000).toISOString();
}
