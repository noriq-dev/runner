import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type AuthorizationMetadata,
  pkcePair,
  postToken,
  randomState,
  type TokenResponse,
} from "./oauth.js";

export const LOOPBACK_REDIRECT = "http://127.0.0.1/callback";
const LOOPBACK_HOST = "127.0.0.1";

export function hasBrowser(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (environment.NORIQ_NO_BROWSER) return false;
  if (
    environment.SSH_CONNECTION ||
    environment.SSH_TTY ||
    environment.SSH_CLIENT
  )
    return false;
  if (platform === "darwin" || platform === "win32") return true;
  return Boolean(environment.DISPLAY || environment.WAYLAND_DISPLAY);
}

export function openBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

export async function loopbackAuthorize(options: {
  metadata: AuthorizationMetadata;
  clientId: string;
  fetchImpl?: typeof fetch;
  open?: (url: string) => void;
  onUrl?: (url: string) => void;
  timeoutMs?: number;
}): Promise<TokenResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { verifier, challenge } = pkcePair();
  const state = randomState();
  const server = createServer();
  const code = new Promise<string>((resolve, reject) => {
    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      const returnedState = url.searchParams.get("state");
      const returnedCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      if (error) {
        response
          .writeHead(400)
          .end("Authorization denied. You may close this tab.");
        reject(new Error(`authorization denied: ${error}`));
      } else if (!returnedState || returnedState !== state) {
        response.writeHead(400).end("Authorization state mismatch.");
        reject(new Error("OAuth state mismatch"));
      } else if (!returnedCode) {
        response.writeHead(400).end("No authorization code was returned.");
        reject(new Error("OAuth callback contained no code"));
      } else {
        response
          .writeHead(200)
          .end("Noriq Runner connected. You may close this tab.");
        resolve(returnedCode);
      }
    });
    server.on("error", reject);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://${LOOPBACK_HOST}:${port}/callback`;
  const authorization = new URL(options.metadata.authorization_endpoint);
  const values = {
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: redirectUri,
    scope: "mcp",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  for (const [key, value] of Object.entries(values))
    authorization.searchParams.set(key, value);
  let timer: NodeJS.Timeout | undefined;
  try {
    const url = authorization.toString();
    options.onUrl?.(url);
    (options.open ?? openBrowser)(url);
    const authorizationCode = await Promise.race([
      code,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "timed out waiting for browser authorization; retry with --device",
              ),
            ),
          options.timeoutMs ?? 300_000,
        );
      }),
    ]);
    const result = await postToken(
      options.metadata,
      {
        grant_type: "authorization_code",
        code: authorizationCode,
        redirect_uri: redirectUri,
        client_id: options.clientId,
        code_verifier: verifier,
      },
      fetchImpl,
    );
    if (!result.ok)
      throw new Error(`token exchange failed: ${result.error.error}`);
    return result.token;
  } finally {
    if (timer) clearTimeout(timer);
    server.close();
  }
}
