export type TokenKind = "static" | "oauth";

export interface TokenSnapshot {
  accessToken: string;
  generation: number;
  kind: TokenKind;
  expiresAt: string | null;
}

export interface TokenProvider {
  readonly kind: TokenKind;
  get(forceRefresh?: boolean): Promise<TokenSnapshot>;
  canRefresh(): Promise<boolean>;
  status(): Promise<{
    kind: TokenKind;
    authenticated: boolean;
    generation: number;
    expiresAt: string | null;
    reauthRequired: boolean;
  }>;
}

export class ReauthenticationRequiredError extends Error {
  constructor(
    message = "Noriq authorization expired; run `noriq-runner auth noriq --reauth`",
  ) {
    super(message);
    this.name = "ReauthenticationRequiredError";
  }
}
