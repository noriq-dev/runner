import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CREDENTIALS_PATH,
  type StoredCredentials,
  expiryFrom,
  loadCredentials,
  sameServer,
  saveCredentials,
} from './credentials';
import { type AsMetadata, discover, refreshToken } from './oauth';

/** The daemon's OAuth token lives here by default — a local secret, never committed
 *  and never in runner.toml (only the token itself crosses the wire). */
export const DEFAULT_TOKEN_PATH = path.join(os.homedir(), '.noriq', 'token');

export const NO_TOKEN_MESSAGE = 'no Noriq token — run `noriq-runner auth` (or set NORIQ_TOKEN)';

/**
 * Load the Noriq OAuth access token the daemon authenticates with. Precedence:
 * NORIQ_TOKEN env var, then credentials.json (written by `noriq-runner auth`), then the
 * legacy bare-token file. Throws with guidance if none is present.
 *
 * This is the static read. Long-lived callers want `TokenSource`, which also refreshes.
 */
export async function loadToken(
  opts: { tokenPath?: string; credentialsPath?: string; env?: NodeJS.ProcessEnv; server?: string } = {},
): Promise<string> {
  const env = opts.env ?? process.env;
  const fromEnv = env.NORIQ_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const creds = await loadCredentials(opts.credentialsPath ?? DEFAULT_CREDENTIALS_PATH);
  // Credentials are server-scoped: a token minted for another Noriq instance is not a
  // credential for this one, so fall through rather than send it and 401.
  if (creds && (!opts.server || sameServer(creds.server, opts.server))) return creds.accessToken;

  const tokenPath = opts.tokenPath ?? DEFAULT_TOKEN_PATH;
  if (existsSync(tokenPath)) {
    const fromFile = (await readFile(tokenPath, 'utf8')).trim();
    if (fromFile) return fromFile;
  }
  throw new Error(NO_TOKEN_MESSAGE);
}

export interface TokenSourceOptions {
  server: string;
  credentialsPath?: string;
  tokenPath?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Refresh this far before the token actually expires. Default 5 min. */
  skewMs?: number;
  now?: () => number;
  onRefresh?: (creds: StoredCredentials) => void;
}

/**
 * The daemon's token, kept live.
 *
 * Noriq access tokens last 7 days and the daemon is meant to run for months, so a
 * static read would strand every runner offline a week after `auth`. This refreshes
 * ahead of expiry (and on demand after a 401) and persists the rotated pair — Noriq
 * revokes the old refresh token on use, so NOT saving it would lock the runner out.
 *
 * A NORIQ_TOKEN env var or a legacy bare-token file has no refresh half; those stay
 * static and simply fail when they lapse.
 */
export class TokenSource {
  private readonly opts: Required<
    Pick<TokenSourceOptions, 'credentialsPath' | 'tokenPath' | 'skewMs' | 'now'>
  > &
    TokenSourceOptions;
  private creds: StoredCredentials | null = null;
  private staticToken: string | null = null;
  private meta: AsMetadata | null = null;
  private loaded = false;
  /** In-flight refresh, shared so concurrent callers can't rotate twice and revoke
   *  each other's brand-new refresh token. */
  private refreshing: Promise<string> | null = null;

  constructor(options: TokenSourceOptions) {
    this.opts = {
      credentialsPath: options.credentialsPath ?? DEFAULT_CREDENTIALS_PATH,
      tokenPath: options.tokenPath ?? DEFAULT_TOKEN_PATH,
      skewMs: options.skewMs ?? 5 * 60_000,
      now: options.now ?? Date.now,
      ...options,
    };
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const env = this.opts.env ?? process.env;
    const fromEnv = env.NORIQ_TOKEN?.trim();
    if (fromEnv) {
      this.staticToken = fromEnv;
      this.loaded = true;
      return;
    }
    const creds = await loadCredentials(this.opts.credentialsPath);
    if (creds && sameServer(creds.server, this.opts.server)) {
      this.creds = creds;
      this.loaded = true;
      return;
    }
    if (existsSync(this.opts.tokenPath)) {
      const fromFile = (await readFile(this.opts.tokenPath, 'utf8')).trim();
      if (fromFile) {
        this.staticToken = fromFile;
        this.loaded = true;
        return;
      }
    }
    this.loaded = true;
    throw new Error(NO_TOKEN_MESSAGE);
  }

  /** True when the stored token is refreshable (i.e. came from `auth`). */
  async canRefresh(): Promise<boolean> {
    await this.load();
    return Boolean(this.creds?.refreshToken);
  }

  /** The current access token, refreshed first if it's at or near expiry. */
  async get(): Promise<string> {
    await this.load();
    if (this.staticToken) return this.staticToken;
    const creds = this.creds;
    if (!creds) throw new Error(NO_TOKEN_MESSAGE);
    if (creds.refreshToken && creds.expiresAt) {
      const expiresMs = Date.parse(creds.expiresAt);
      if (Number.isFinite(expiresMs) && this.opts.now() >= expiresMs - this.opts.skewMs)
        return this.refresh();
    }
    return creds.accessToken;
  }

  /**
   * Force a refresh — what a 401 should trigger. Returns the token unchanged when
   * there's nothing to refresh with, so callers can retry-once without special-casing.
   */
  async refresh(): Promise<string> {
    await this.load();
    if (this.staticToken) return this.staticToken;
    if (!this.creds?.refreshToken) throw new Error(NO_TOKEN_MESSAGE);
    // Coalesce: the REST client and the WS client can both notice expiry at once, and
    // the second rotation would revoke the first's fresh pair.
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<string> {
    const creds = this.creds;
    if (!creds?.refreshToken) throw new Error(NO_TOKEN_MESSAGE);
    if (!this.meta) this.meta = await discover(this.opts.server, this.opts.fetchImpl);
    let token: Awaited<ReturnType<typeof refreshToken>>;
    try {
      token = await refreshToken(this.meta, creds.clientId, creds.refreshToken, this.opts.fetchImpl);
    } catch (err) {
      // A dead refresh token is unrecoverable without a human: say so plainly rather
      // than let the daemon retry-loop against a 400 forever.
      throw new Error(`${(err as Error).message} — run \`noriq-runner auth\` to reconnect this runner`);
    }
    const next: StoredCredentials = {
      ...creds,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? creds.refreshToken,
      expiresAt: token.expires_in ? expiryFrom(token.expires_in, this.opts.now()) : null,
      scope: token.scope ?? creds.scope ?? null,
    };
    await saveCredentials(next, this.opts.credentialsPath);
    this.creds = next;
    this.opts.onRefresh?.(next);
    return next.accessToken;
  }
}
