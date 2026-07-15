import os from 'node:os';
import { deviceAuthorize } from './auth-device';
import { LOOPBACK_REDIRECT, hasBrowser, loopbackAuthorize } from './auth-loopback';
import {
  DEFAULT_CREDENTIALS_PATH,
  type StoredCredentials,
  expiryFrom,
  loadCredentials,
  sameServer,
  saveCredentials,
} from './credentials';
import { DEVICE_GRANT, discover, registerClient } from './oauth';

/** How `auth` chooses its flow. `auto` = browser when there is one, device otherwise. */
export type AuthMode = 'auto' | 'browser' | 'device';

export interface AuthorizeOptions {
  server: string;
  mode?: AuthMode;
  credentialsPath?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  /** User-facing output (the CLI passes console.log). */
  out?: (line: string) => void;
  open?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Resolve `auto` against the box we're actually on. */
export function resolveMode(mode: AuthMode, env: NodeJS.ProcessEnv, platform: string): 'browser' | 'device' {
  if (mode !== 'auto') return mode;
  return hasBrowser(env, platform) ? 'browser' : 'device';
}

/**
 * Get this machine a Noriq token and persist it.
 *
 * The browser path is the default because it's one click. The device path is the
 * fallback for boxes that can't open one — a runner over SSH, in a container, on CI.
 * Both land in the same place: a rotating access+refresh pair in credentials.json.
 */
export async function authorize(o: AuthorizeOptions): Promise<StoredCredentials> {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const out = o.out ?? (() => {});
  const credentialsPath = o.credentialsPath ?? DEFAULT_CREDENTIALS_PATH;
  const server = o.server.replace(/\/+$/, '');
  const mode = resolveMode(o.mode ?? 'auto', env, platform);

  const meta = await discover(server, o.fetchImpl);

  // Reuse the client_id from a previous auth against this same server — re-authing
  // shouldn't litter the server with a new client registration every time.
  const existing = await loadCredentials(credentialsPath);
  const clientId =
    existing?.clientId && sameServer(existing.server, server)
      ? existing.clientId
      : await registerClient(
          meta,
          {
            clientName: `noriq-runner (${os.hostname()})`,
            // Register for both grants up front: the same install may run headed today
            // and headless tomorrow, and re-registering mid-fallback would be worse.
            redirectUris: [LOOPBACK_REDIRECT],
            grantTypes: ['authorization_code', DEVICE_GRANT],
          },
          o.fetchImpl,
        );

  const token =
    mode === 'browser'
      ? await loopbackAuthorize({
          meta,
          clientId,
          fetchImpl: o.fetchImpl,
          open: o.open,
          onUrl: (url) => {
            out('Opening your browser to approve this runner…');
            out(`  If it didn't open: ${url}`);
          },
        })
      : await deviceAuthorize({
          meta,
          clientId,
          fetchImpl: o.fetchImpl,
          sleep: o.sleep,
          onPrompt: (info) => {
            out('');
            out(`  Open:  ${info.verification_uri_complete ?? info.verification_uri}`);
            out(`  Code:  ${info.user_code}`);
            out('');
            out('Waiting for approval…');
          },
        });

  const creds: StoredCredentials = {
    server,
    clientId,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    expiresAt: token.expires_in ? expiryFrom(token.expires_in) : null,
    scope: token.scope ?? null,
  };
  await saveCredentials(creds, credentialsPath);
  return creds;
}
