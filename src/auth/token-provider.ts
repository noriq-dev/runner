import type { MachineConfig } from "../config.js";
import {
  DEFAULT_CREDENTIALS_PATH,
  expiryFrom,
  loadCredential,
  type StoredCredential,
  updateCredential,
} from "./credentials.js";
import { discover, refreshToken } from "./oauth.js";
import {
  ReauthenticationRequiredError,
  type TokenProvider,
  type TokenSnapshot,
} from "./types.js";

export class StaticTokenProvider implements TokenProvider {
  readonly kind = "static" as const;
  constructor(private readonly token: string) {}
  async get(): Promise<TokenSnapshot> {
    return {
      accessToken: this.token,
      generation: 0,
      kind: this.kind,
      expiresAt: null,
    };
  }
  async canRefresh(): Promise<boolean> {
    return false;
  }
  async status() {
    return {
      kind: this.kind,
      authenticated: true,
      generation: 0,
      expiresAt: null,
      reauthRequired: false,
    } as const;
  }
}

export class OAuthTokenProvider implements TokenProvider {
  readonly kind = "oauth" as const;
  private current: StoredCredential | null = null;
  private refreshInFlight: Promise<TokenSnapshot> | null = null;
  private reauthRequired = false;

  constructor(
    private readonly options: {
      server: string;
      credentialsPath?: string;
      fetchImpl?: typeof fetch;
      now?: () => number;
      skewMs?: number;
    },
  ) {}

  private get path(): string {
    return this.options.credentialsPath ?? DEFAULT_CREDENTIALS_PATH;
  }

  private async reload(): Promise<StoredCredential> {
    const stored = await loadCredential(this.options.server, this.path);
    if (!stored)
      throw new ReauthenticationRequiredError(
        "No Noriq OAuth credentials; run `noriq-runner auth noriq`",
      );
    const previousGeneration = this.current?.generation ?? -1;
    if (!this.current || stored.generation >= previousGeneration)
      this.current = stored;
    if (this.reauthRequired && stored.generation > previousGeneration)
      this.reauthRequired = false;
    return this.current;
  }

  async get(forceRefresh = false): Promise<TokenSnapshot> {
    const credential = await this.reload();
    if (this.reauthRequired) throw new ReauthenticationRequiredError();
    const now = (this.options.now ?? Date.now)();
    const expiry = credential.expiresAt
      ? Date.parse(credential.expiresAt)
      : Number.POSITIVE_INFINITY;
    const expiring =
      Number.isFinite(expiry) &&
      now >= expiry - (this.options.skewMs ?? 300_000);
    if ((forceRefresh || expiring) && credential.refreshToken)
      return this.refresh();
    if (forceRefresh || expiring) {
      this.reauthRequired = true;
      throw new ReauthenticationRequiredError(
        "Noriq OAuth credentials cannot be refreshed; run `noriq-runner auth noriq --reauth`",
      );
    }
    return this.snapshot(credential);
  }

  private snapshot(credential: StoredCredential): TokenSnapshot {
    return {
      accessToken: credential.accessToken,
      generation: credential.generation,
      kind: this.kind,
      expiresAt: credential.expiresAt,
    };
  }

  private async refresh(): Promise<TokenSnapshot> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.rotate().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async rotate(): Promise<TokenSnapshot> {
    try {
      const next = await updateCredential(
        this.options.server,
        async (stored) => {
          if (!stored?.refreshToken) throw new ReauthenticationRequiredError();
          if (this.current && stored.generation > this.current.generation)
            return stored;
          const metadata = await discover(
            this.options.server,
            this.options.fetchImpl,
          );
          const token = await refreshToken(
            metadata,
            stored.clientId,
            stored.refreshToken,
            this.options.fetchImpl,
          );
          return {
            ...stored,
            accessToken: token.access_token,
            refreshToken: token.refresh_token ?? stored.refreshToken,
            expiresAt: token.expires_in
              ? expiryFrom(token.expires_in, (this.options.now ?? Date.now)())
              : null,
            scope: token.scope ?? stored.scope,
            generation: stored.generation + 1,
            updatedAt: new Date((this.options.now ?? Date.now)()).toISOString(),
          };
        },
        this.path,
      );
      this.current = next;
      this.reauthRequired = false;
      return this.snapshot(next);
    } catch (error) {
      if ((error as { oauthCode?: unknown }).oauthCode === "invalid_grant") {
        this.reauthRequired = true;
        throw new ReauthenticationRequiredError();
      }
      throw error;
    }
  }

  async canRefresh(): Promise<boolean> {
    try {
      return Boolean((await this.reload()).refreshToken);
    } catch {
      return false;
    }
  }

  async status() {
    try {
      const credential = await this.reload();
      return {
        kind: this.kind,
        authenticated: !this.reauthRequired,
        generation: credential.generation,
        expiresAt: credential.expiresAt,
        reauthRequired: this.reauthRequired,
      } as const;
    } catch {
      return {
        kind: this.kind,
        authenticated: false,
        generation: 0,
        expiresAt: null,
        reauthRequired: true,
      } as const;
    }
  }
}

export function createTokenProvider(config: MachineConfig): TokenProvider {
  if (config.runner.token) return new StaticTokenProvider(config.runner.token);
  return new OAuthTokenProvider({
    server: config.runner.serverUrl,
    ...(config.auth.noriq.credentialsFile
      ? { credentialsPath: config.auth.noriq.credentialsFile }
      : {}),
  });
}
