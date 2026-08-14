import type { TokenProvider, TokenSnapshot } from "../auth/types.js";

export class NoriqHttpClient {
  constructor(
    readonly serverUrl: string,
    private readonly tokens: TokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async token(forceRefresh = false): Promise<TokenSnapshot> {
    return this.tokens.get(forceRefresh);
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const send = async (forceRefresh: boolean): Promise<Response> => {
      const token = await this.tokens.get(forceRefresh);
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token.accessToken}`);
      return this.fetchImpl(new URL(path, this.serverUrl), {
        ...init,
        headers,
      });
    };
    const first = await send(false);
    if (first.status !== 401 || !(await this.tokens.canRefresh())) return first;
    first.body?.cancel().catch(() => {});
    return send(true);
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `Noriq request ${path} failed (${response.status}): ${text.slice(0, 500)}`,
      );
    return JSON.parse(text) as T;
  }
}
