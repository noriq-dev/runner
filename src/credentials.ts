import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * What `noriq-runner auth` persists. Unlike the legacy bare-token file this carries the
 * refresh token and expiry, because Noriq access tokens live 7 days and the daemon is
 * expected to run for months — without a refresh path every runner would silently drop
 * offline a week after it was authorized.
 */
export interface StoredCredentials {
  /** The server these tokens are for. Credentials for a different server are ignored. */
  server: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string | null;
  /** ISO timestamp; absent means "unknown, treat as live until it 401s". */
  expiresAt?: string | null;
  scope?: string | null;
}

export const DEFAULT_CREDENTIALS_PATH = path.join(os.homedir(), '.noriq', 'credentials.json');

/** Normalize an origin for comparison — trailing slashes and case shouldn't unpair a token. */
export const sameServer = (a: string, b: string): boolean =>
  a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();

/** Read stored credentials, or null if absent/unreadable/corrupt. */
export async function loadCredentials(
  credentialsPath = DEFAULT_CREDENTIALS_PATH,
): Promise<StoredCredentials | null> {
  let raw: string;
  try {
    raw = await readFile(credentialsPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as StoredCredentials;
    if (!parsed?.accessToken || !parsed?.server) return null;
    return parsed;
  } catch {
    // A truncated write shouldn't wedge the daemon — re-authing is the fix, and the
    // caller's "no credentials" path already says so.
    return null;
  }
}

/** Write credentials 0600 under a 0700 dir — this file is a live secret. */
export async function saveCredentials(
  creds: StoredCredentials,
  credentialsPath = DEFAULT_CREDENTIALS_PATH,
): Promise<void> {
  await mkdir(path.dirname(credentialsPath), { recursive: true, mode: 0o700 });
  await writeFile(credentialsPath, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
}

/** Seconds-from-now → ISO expiry, the shape `expires_in` arrives in. */
export const expiryFrom = (expiresInSeconds: number, now = Date.now()): string =>
  new Date(now + expiresInSeconds * 1000).toISOString();
