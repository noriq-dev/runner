import { hostname } from "node:os";
import {
  DEFAULT_CREDENTIALS_PATH,
  expiryFrom,
  loadCredential,
  type StoredCredential,
  updateCredential,
} from "./credentials.js";
import { deviceAuthorize } from "./device.js";
import {
  hasBrowser,
  LOOPBACK_REDIRECT,
  loopbackAuthorize,
} from "./loopback.js";
import {
  canonicalServer,
  DEVICE_GRANT,
  discover,
  registerClient,
} from "./oauth.js";

export type AuthorizationMode = "auto" | "browser" | "device";

export async function authorize(options: {
  server: string;
  mode?: AuthorizationMode;
  credentialsPath?: string;
  fetchImpl?: typeof fetch;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  out?: (line: string) => void;
  open?: (url: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<StoredCredential> {
  const server = canonicalServer(options.server);
  const credentialsPath = options.credentialsPath ?? DEFAULT_CREDENTIALS_PATH;
  const out = options.out ?? (() => {});
  const mode =
    options.mode && options.mode !== "auto"
      ? options.mode
      : hasBrowser(options.environment, options.platform)
        ? "browser"
        : "device";
  const metadata = await discover(server, options.fetchImpl);
  const current = await loadCredential(server, credentialsPath);
  const clientId =
    current?.clientId ||
    (await registerClient(
      metadata,
      {
        clientName: `noriq-runner (${hostname()})`,
        redirectUris: [LOOPBACK_REDIRECT],
        grantTypes: ["authorization_code", DEVICE_GRANT],
      },
      options.fetchImpl,
    ));
  const token =
    mode === "browser"
      ? await loopbackAuthorize({
          metadata,
          clientId,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          ...(options.open ? { open: options.open } : {}),
          onUrl: (url) => {
            out("Opening Noriq authorization in your browser.");
            out(`If it does not open, visit: ${url}`);
          },
        })
      : await deviceAuthorize({
          metadata,
          clientId,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          ...(options.sleep ? { sleep: options.sleep } : {}),
          onPrompt: (device) => {
            out(
              `Open: ${device.verification_uri_complete ?? device.verification_uri}`,
            );
            out(`Code: ${device.user_code}`);
            out("Waiting for approval…");
          },
        });
  return updateCredential(
    server,
    (prior) => ({
      server,
      clientId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? prior?.refreshToken ?? null,
      expiresAt: token.expires_in ? expiryFrom(token.expires_in) : null,
      scope: token.scope ?? prior?.scope ?? null,
      generation: (prior?.generation ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    }),
    credentialsPath,
  );
}
