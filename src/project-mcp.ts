import { createHash } from 'node:crypto';
import { constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { openConfined } from './repo-context';

/**
 * An explicitly selected MCP declaration after Runner has validated it. This is deliberately a
 * transport contract, not a catalogue of domain integrations. A repository declaration and a
 * Noriq-managed agent-environment declaration have exactly the same shape and validation path.
 */
export type ProjectMcpServer =
  | {
      transport: 'stdio';
      command: string;
      args: readonly string[];
      env: Readonly<Record<string, string>>;
    }
  | {
      transport: 'http' | 'sse';
      url: string;
      headers: Readonly<Record<string, string>>;
    };

export interface ProjectMcpBundle {
  /** Local evidence only. Never include this absolute path in a Noriq advertisement. */
  source: string;
  /** Hash of the portable declaration: suitable for control-plane offers and commissions. */
  declarationFingerprint: string;
  /** Hash of exact local policy, endpoints, executable paths, and bound args. Keep it off-box. */
  effectiveFingerprint: string;
  /** Trusted local authorization for each stdio executable; absent for remote transports. */
  launcherAuthorizations: Readonly<Record<string, ProjectMcpLauncherAuthorization>>;
  /** Trusted authorization and resolved endpoint for each remote transport. */
  endpointAuthorizations: Readonly<Record<string, ProjectMcpEndpointAuthorization>>;
  servers: Readonly<Record<string, ProjectMcpServer>>;
}

export interface ProjectMcpLauncherRequest {
  source: string;
  serverName: string;
  /** Always a bare executable name: paths are rejected before policy evaluation. */
  command: string;
  /** Portable arguments after traversal and workspace-token validation. */
  args: readonly string[];
  /**
   * Repository arguments may be rebound to a leased workspace. Agent-environment arguments are
   * never guessed by Runner: trusted machine policy owns the semantics of every exact argument.
   */
  argumentBinding: 'workspace' | 'policy';
  /** Hash of command, complete argument vector, and argumentBinding. */
  argvIdentity: string;
}

export interface ProjectMcpLauncherAuthorization {
  /** Stable local policy identity. Changing policy changes only the local effective fingerprint. */
  policyId: string;
  /** Exact package/version, executable digest, or equivalent immutable identity proved by policy. */
  executableIdentity: string;
  /**
   * Immutable identity for the complete runtime closure, or for a policy-owned broker which
   * encapsulates that closure. Hashing only a script/front-end executable is not sufficient.
   */
  runtimeClosureIdentity: string;
  /**
   * Echo of the request argvIdentity after policy evaluated the complete vector. Authorizing only
   * the command or one package selector is insufficient and is rejected by Runner.
   */
  authorizedArgvIdentity: string;
  /** Canonical executable selected by trusted machine policy; drivers never resolve the bare name. */
  resolvedCommand: string;
  /** Exact runtime/toolchain roots made visible read-only to the contained parent and MCP child. */
  readOnlyRoots: readonly string[];
}

/**
 * Machine-owned executable trust. A policy may authorize pinned npm, uv, or native launchers by
 * digest without teaching the project declaration or Runner core about a domain integration.
 */
export interface ProjectMcpLauncherPolicy {
  policyId: string;
  authorize(
    request: ProjectMcpLauncherRequest,
  ): ProjectMcpLauncherAuthorization | null | Promise<ProjectMcpLauncherAuthorization | null>;
}

export interface ProjectMcpEndpointRequest {
  source: string;
  serverName: string;
  transport: 'http' | 'sse';
  /** Untrusted selected declaration. Policy may map it to a separately resolved broker URL. */
  declaredUrl: string;
}

export interface ProjectMcpEndpointAuthorization {
  /** Stable local policy identity. Changing policy changes only the local effective fingerprint. */
  policyId: string;
  /** Immutable endpoint or broker identity established by trusted machine policy. */
  endpointIdentity: string;
  /** Exact trusted URL used by the driver; never inferred from repository trust alone. */
  resolvedUrl: string;
}

/** Machine-owned remote endpoint policy. Omission denies every declaration-supplied URL. */
export interface ProjectMcpEndpointPolicy {
  policyId: string;
  authorize(
    request: ProjectMcpEndpointRequest,
  ): ProjectMcpEndpointAuthorization | null | Promise<ProjectMcpEndpointAuthorization | null>;
}

export interface ProjectMcpLoadOptions {
  /** Override only for tests or an explicitly selected declaration inside `declarationRoot`. */
  filename?: string;
  /** Server injected by Runner itself. Selected declarations may never shadow it. */
  reservedNames?: readonly string[];
  /** A bounded inventory keeps one declaration from creating unbounded process fan-out. */
  maxServers?: number;
  /** Reject oversized executable declarations before parsing or launching anything. */
  maxBytes?: number;
  /** Required for every stdio server. Omitted means remote-only: local execution is denied. */
  launcherPolicy?: ProjectMcpLauncherPolicy;
  /** Required for every HTTP/SSE server. Omitted means declaration-supplied network access is denied. */
  endpointPolicy?: ProjectMcpEndpointPolicy;
  /**
   * How arguments are interpreted. Repository declarations use `workspace`: a confined `./file`
   * or absolute path beneath the declaration root follows the leased checkout. Agent-environment
   * declarations use `policy`: Runner performs no path-shape guessing, and trusted machine policy
   * must authorize the complete exact argv. Project paths must still spell `${workspace}`
   * explicitly.
   */
  implicitPathBinding?: 'workspace' | 'policy';
}

/** Compatibility names retained while the rest of Runner still calls this surface "project MCP". */
export type McpBundle = ProjectMcpBundle;
export type McpLoadOptions = ProjectMcpLoadOptions;

export interface McpBundleCompositionOptions {
  /** Bound the number of independently managed declaration roots in one agent environment. */
  maxBundles?: number;
  /** Bound aggregate server fan-out after all declarations are combined. */
  maxServers?: number;
  /** Additional machine-reserved names which no contributing declaration may claim. */
  reservedNames?: readonly string[];
}

export class ProjectMcpConfigError extends Error {
  constructor(
    readonly source: string,
    readonly detail: string,
  ) {
    super(`invalid MCP config ${source}: ${detail}`);
    this.name = 'ProjectMcpConfigError';
  }
}

const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_MAX_SERVERS = 16;
const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_BUNDLES = 8;
const MAX_ARGS = 128;
const MAX_ARGUMENT_CHARS = 16_384;
const MAX_ENV = 64;
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MUTABLE_SELECTOR = /(?:@|:)(?:latest|next|beta|alpha|canary|dev|nightly)$/i;
const AUTHORITY_TEXT = /^[\x21-\x7e]{1,512}$/;
const ARGV_IDENTITY = /^sha256:[a-f0-9]{64}$/;
const BARE_EXECUTABLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUNNER_RESERVED_SERVERS = new Set(['noriq', 'codex_apps']);
/**
 * Bundles are local authority objects, not serializable data. Composition accepts only objects
 * produced by this module's confined loader (or by an earlier composition) so a caller cannot
 * forge launcher-policy evidence by constructing a shape-compatible object.
 */
interface ProjectMcpExecutableProof {
  resolvedCommand: string;
  executableSha256: string;
  readOnlyRoots: readonly string[];
}

interface ProjectMcpBundleProof {
  phase: 'portable' | 'bound';
  /** Portable declarations retain declared endpoints, never machine-resolved broker URLs. */
  declarations: Readonly<Record<string, ProjectMcpServer>>;
  executables: Readonly<Record<string, ProjectMcpExecutableProof>>;
}

const validatedMcpBundles = new WeakMap<object, ProjectMcpBundleProof>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const requireExactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  source: string,
): void => {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new ProjectMcpConfigError(source, `${field} contains unsupported field '${extras[0]}'`);
  }
};

const stringRecord = (
  value: unknown,
  field: string,
  source: string,
  maxEntries: number,
): Record<string, string> => {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ProjectMcpConfigError(source, `${field} must be an object`);
  const entries = Object.entries(value);
  if (entries.length > maxEntries) {
    throw new ProjectMcpConfigError(
      source,
      `${field} has ${entries.length} entries; maximum is ${maxEntries}`,
    );
  }
  const out: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (!key || typeof item !== 'string') {
      throw new ProjectMcpConfigError(source, `${field} must contain non-empty keys and string values`);
    }
    out[key] = item;
  }
  return out;
};

const secureEmptyRecord = (
  value: unknown,
  field: string,
  source: string,
): Readonly<Record<string, string>> => {
  const record = stringRecord(value, field, source, MAX_ENV);
  if (Object.keys(record).length > 0) {
    throw new ProjectMcpConfigError(
      source,
      `${field} is not supported: MCP declarations may not carry literal credentials`,
    );
  }
  return record;
};

const stringArray = (value: unknown, field: string, source: string): string[] => {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.length > MAX_ARGUMENT_CHARS || item.includes('\0'))
  ) {
    throw new ProjectMcpConfigError(source, `${field} must be an array of strings`);
  }
  if (value.length > MAX_ARGS) {
    throw new ProjectMcpConfigError(source, `${field} has ${value.length} entries; maximum is ${MAX_ARGS}`);
  }
  return [...value];
};

const nonEmpty = (value: unknown, field: string, source: string): string => {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value !== value.trim() ||
    value.includes('\0') ||
    value.length > MAX_ARGUMENT_CHARS
  ) {
    throw new ProjectMcpConfigError(source, `${field} must be a bounded, exact non-empty string`);
  }
  return value;
};

const normalizeWorkspaceToken = (value: string, source: string): string => {
  const token = '${workspace}';
  if (!value.includes(token)) return value;
  if (value === token) return value;
  if (!value.startsWith(`${token}/`) || value.indexOf(token, token.length) !== -1) {
    throw new ProjectMcpConfigError(source, `workspace token in '${value}' is not a confined path`);
  }
  // The declaration is portable, so both POSIX and Windows separators are path boundaries even
  // when Runner is validating it on another platform. Otherwise `safe\\..\\..\\outside` passes on
  // POSIX and escapes only after the token is bound on Windows.
  const segments = value.slice(token.length + 1).split(/[\\/]/);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new ProjectMcpConfigError(source, `workspace token in '${value}' is not a confined path`);
  }
  return value;
};

const relativeWithinRoot = (root: string, candidate: string): string | null => {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative;
};

const normalizePortableArg = (
  value: string,
  declarationRootAliases: readonly string[],
  source: string,
  implicitPathBinding: NonNullable<ProjectMcpLoadOptions['implicitPathBinding']>,
): string => {
  if (MUTABLE_SELECTOR.test(value)) {
    throw new ProjectMcpConfigError(source, `mutable executable selector '${value}' is not allowed`);
  }
  const assignment = value.match(/^([^=]{1,256}=)(.+)$/);
  if (assignment) {
    const [, prefix, assigned] = assignment;
    if (
      assigned?.includes('${workspace}') ||
      path.isAbsolute(assigned ?? '') ||
      /^(?:\.{1,2}[\\/]|[A-Za-z0-9_.-]+[\\/])/.test(assigned ?? '')
    ) {
      return `${prefix}${normalizePortableArg(
        assigned!,
        declarationRootAliases,
        source,
        implicitPathBinding,
      )}`;
    }
  }
  const tokenized = normalizeWorkspaceToken(value, source);
  if (value.includes('${workspace}')) return tokenized;
  if (/(?:^|[=:/\\])\.\.(?:[/\\]|$)/.test(value)) {
    throw new ProjectMcpConfigError(source, `argument '${value}' contains path traversal`);
  }
  // Agent-environment argv is intentionally opaque to Runner. A bare value can be a package,
  // filename, socket, editor object, or vendor selector; guessing from punctuation recreated the
  // cwd-retargeting bug this mode exists to prevent. The launcher policy receives the complete
  // exact vector and must echo its identity only after authorizing every argument.
  if (implicitPathBinding === 'policy') return value;
  const relativePath = path.isAbsolute(value)
    ? path.normalize(value)
    : /^(?:\.{1,2}[\\/]|[A-Za-z0-9_.-]+[\\/])/.test(value)
      ? path.resolve(declarationRootAliases[0]!, value)
      : null;
  if (relativePath === null) return value;
  // The declaration root may itself be reached through a trusted symlink (for example
  // /home -> /var/home).
  // Accept an absolute declaration written under either the caller's spelling or the canonical
  // realpath, then preserve only its relative suffix for the leased workspace.
  const relative = declarationRootAliases
    .map((root) => relativeWithinRoot(root, relativePath))
    .find((candidate): candidate is string => candidate !== null);
  if (relative === undefined) {
    throw new ProjectMcpConfigError(
      source,
      `absolute argument '${value}' is outside the selected declaration root and cannot follow a leased workspace`,
    );
  }
  return relative === '' ? '${workspace}' : `${'${workspace}'}/${relative.split(path.sep).join('/')}`;
};

const blockedIpv4 = (hostname: string): boolean => {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
};

const blockedEndpointHostname = (hostname: string): boolean => {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal')
  ) {
    return true;
  }
  const family = isIP(normalized);
  if (family === 4) return blockedIpv4(normalized);
  if (family === 6) {
    if (normalized === '::' || normalized === '::1') return true;
    if (/^(?:fc|fd|fe[89ab]|ff)/i.test(normalized) || /^fec[0-9a-f]:/i.test(normalized)) return true;
    const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
    if (mapped) return blockedIpv4(mapped);
    // WHATWG URL canonicalizes dotted IPv4-mapped IPv6 into hexadecimal final words, e.g.
    // ::ffff:127.0.0.1 -> ::ffff:7f00:1. Decode the final 32 bits before applying IPv4 policy.
    const mappedHex = normalized.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1]!, 16);
      const low = Number.parseInt(mappedHex[2]!, 16);
      const address = `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
      return blockedIpv4(address);
    }
    return false;
  }
  return false;
};

const trustedHttpsEndpoint = (value: string, field: string, source: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(nonEmpty(value, field, source));
  } catch (error) {
    if (error instanceof ProjectMcpConfigError) throw error;
    throw new ProjectMcpConfigError(source, `${field} must be an absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    blockedEndpointHostname(parsed.hostname)
  ) {
    throw new ProjectMcpConfigError(
      source,
      `${field} must be credential-free HTTPS and may not target a local, private, or link-local address`,
    );
  }
  return parsed.toString();
};

const launcherArgvIdentity = (
  command: string,
  args: readonly string[],
  argumentBinding: ProjectMcpLauncherRequest['argumentBinding'],
): string =>
  `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        schema: 'project-mcp-launcher-argv.v1',
        command,
        args,
        argumentBinding,
      }),
      'utf8',
    )
    .digest('hex')}`;

const normalizeServer = async (
  name: string,
  value: unknown,
  source: string,
  declarationRootAliases: readonly string[],
  implicitPathBinding: NonNullable<ProjectMcpLoadOptions['implicitPathBinding']>,
  launcherPolicy: ProjectMcpLauncherPolicy | undefined,
  endpointPolicy: ProjectMcpEndpointPolicy | undefined,
): Promise<{
  server: ProjectMcpServer;
  declaration: ProjectMcpServer;
  launcherAuthorization?: ProjectMcpLauncherAuthorization;
  executableProof?: ProjectMcpExecutableProof;
  endpointAuthorization?: ProjectMcpEndpointAuthorization;
}> => {
  if (!isRecord(value)) throw new ProjectMcpConfigError(source, `mcpServers.${name} must be an object`);
  const hasCommand = value.command !== undefined;
  const hasUrl = value.url !== undefined;
  if (hasCommand === hasUrl) {
    throw new ProjectMcpConfigError(
      source,
      `mcpServers.${name} must declare exactly one of command (stdio) or url (remote)`,
    );
  }

  if (hasCommand) {
    requireExactKeys(value, ['type', 'command', 'args', 'env'], `mcpServers.${name}`, source);
    if (value.type !== undefined && value.type !== 'stdio') {
      throw new ProjectMcpConfigError(source, `mcpServers.${name}.type must be 'stdio' when command is set`);
    }
    const command = nonEmpty(value.command, `mcpServers.${name}.command`, source);
    if (!BARE_EXECUTABLE.test(command)) {
      throw new ProjectMcpConfigError(
        source,
        `mcpServers.${name}.command must be a bare executable name; absolute and local executable paths are not allowed`,
      );
    }
    const args = Object.freeze(
      stringArray(value.args, `mcpServers.${name}.args`, source).map((argument) =>
        normalizePortableArg(argument, declarationRootAliases, source, implicitPathBinding),
      ),
    );
    if (!launcherPolicy) {
      throw new ProjectMcpConfigError(
        source,
        `mcpServers.${name} requests local execution but Runner supplied no trusted launcher policy`,
      );
    }
    if (!AUTHORITY_TEXT.test(launcherPolicy.policyId)) {
      throw new Error('project MCP launcher policyId must be bounded printable ASCII');
    }
    const argvIdentity = launcherArgvIdentity(command, args, implicitPathBinding);
    const authorization = await launcherPolicy.authorize(
      Object.freeze({
        source,
        serverName: name,
        command,
        args,
        argumentBinding: implicitPathBinding,
        argvIdentity,
      }),
    );
    if (
      !authorization ||
      authorization.policyId !== launcherPolicy.policyId ||
      !AUTHORITY_TEXT.test(authorization.executableIdentity) ||
      !AUTHORITY_TEXT.test(authorization.runtimeClosureIdentity) ||
      typeof authorization.resolvedCommand !== 'string' ||
      !path.isAbsolute(authorization.resolvedCommand) ||
      !Array.isArray(authorization.readOnlyRoots)
    ) {
      throw new ProjectMcpConfigError(
        source,
        `mcpServers.${name} executable was not authorized by trusted policy '${launcherPolicy.policyId}'`,
      );
    }
    if (
      !ARGV_IDENTITY.test(authorization.authorizedArgvIdentity) ||
      authorization.authorizedArgvIdentity !== argvIdentity
    ) {
      throw new ProjectMcpConfigError(
        source,
        `mcpServers.${name} trusted policy '${launcherPolicy.policyId}' did not authorize the complete argv identity`,
      );
    }
    let resolvedCommand: string;
    let executableSha256: string;
    let readOnlyRoots: readonly string[];
    try {
      resolvedCommand = realpathSync(authorization.resolvedCommand);
      const commandStat = statSync(resolvedCommand);
      if (!commandStat.isFile()) throw new Error('resolved command is not a file');
      if ((commandStat.mode & (constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH)) === 0) {
        throw new Error('resolved command is not executable');
      }
      executableSha256 = createHash('sha256').update(readFileSync(resolvedCommand)).digest('hex');
      readOnlyRoots = Object.freeze(
        authorization.readOnlyRoots.map((root, index) => {
          if (typeof root !== 'string' || !path.isAbsolute(root)) {
            throw new Error(`readOnlyRoots[${index}] is not absolute`);
          }
          const canonical = realpathSync(root);
          if (canonical === path.parse(canonical).root || !statSync(canonical).isDirectory()) {
            throw new Error(`readOnlyRoots[${index}] is not a bounded directory`);
          }
          return canonical;
        }),
      );
    } catch (error) {
      throw new ProjectMcpConfigError(
        source,
        `mcpServers.${name} launcher authorization is not operational: ${String(error)}`,
      );
    }
    return {
      server: {
        transport: 'stdio',
        command,
        args,
        env: secureEmptyRecord(value.env, `mcpServers.${name}.env`, source),
      },
      declaration: {
        transport: 'stdio',
        command,
        args: [...args],
        env: {},
      },
      launcherAuthorization: Object.freeze({
        policyId: authorization.policyId,
        executableIdentity: authorization.executableIdentity,
        runtimeClosureIdentity: authorization.runtimeClosureIdentity,
        authorizedArgvIdentity: authorization.authorizedArgvIdentity,
        resolvedCommand,
        readOnlyRoots,
      }),
      executableProof: Object.freeze({
        resolvedCommand,
        executableSha256,
        readOnlyRoots,
      }),
    };
  }

  requireExactKeys(value, ['type', 'url', 'headers'], `mcpServers.${name}`, source);
  const transport = value.type ?? 'http';
  if (transport !== 'http' && transport !== 'sse') {
    throw new ProjectMcpConfigError(
      source,
      `mcpServers.${name}.type must be 'http' or 'sse' when url is set`,
    );
  }
  const url = nonEmpty(value.url, `mcpServers.${name}.url`, source);
  if (url.includes('${workspace}')) {
    throw new ProjectMcpConfigError(source, `mcpServers.${name}.url may not expose the local workspace path`);
  }
  const declaredUrl = trustedHttpsEndpoint(url, `mcpServers.${name}.url`, source);
  if (!endpointPolicy) {
    throw new ProjectMcpConfigError(
      source,
      `mcpServers.${name} requests network access but Runner supplied no trusted endpoint policy`,
    );
  }
  if (!AUTHORITY_TEXT.test(endpointPolicy.policyId)) {
    throw new Error('project MCP endpoint policyId must be bounded printable ASCII');
  }
  const endpointAuthorization = await endpointPolicy.authorize({
    source,
    serverName: name,
    transport,
    declaredUrl,
  });
  if (
    !endpointAuthorization ||
    endpointAuthorization.policyId !== endpointPolicy.policyId ||
    !AUTHORITY_TEXT.test(endpointAuthorization.endpointIdentity)
  ) {
    throw new ProjectMcpConfigError(
      source,
      `mcpServers.${name} endpoint was not authorized by trusted policy '${endpointPolicy.policyId}'`,
    );
  }
  const resolvedUrl = trustedHttpsEndpoint(
    endpointAuthorization.resolvedUrl,
    `mcpServers.${name}.resolvedUrl`,
    source,
  );
  const frozenEndpointAuthorization = Object.freeze({
    ...endpointAuthorization,
    resolvedUrl,
  });
  return {
    server: {
      transport,
      url: resolvedUrl,
      headers: secureEmptyRecord(value.headers, `mcpServers.${name}.headers`, source),
    },
    declaration: {
      transport,
      url: declaredUrl,
      headers: {},
    },
    endpointAuthorization: frozenEndpointAuthorization,
  };
};

const sortDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
};

const hash = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(sortDeep(value)), 'utf8')
    .digest('hex');

const freezeServers = (
  value: Record<string, ProjectMcpServer>,
): Readonly<Record<string, ProjectMcpServer>> => {
  for (const server of Object.values(value)) {
    if (server.transport === 'stdio') {
      Object.freeze(server.args);
      Object.freeze(server.env);
    } else {
      Object.freeze(server.headers);
    }
    Object.freeze(server);
  }
  return Object.freeze(value);
};

const freezeExecutableProofs = (
  value: Record<string, ProjectMcpExecutableProof>,
): Readonly<Record<string, ProjectMcpExecutableProof>> => {
  for (const proof of Object.values(value)) {
    Object.freeze(proof.readOnlyRoots);
    Object.freeze(proof);
  }
  return Object.freeze(value);
};

const finalizeValidatedBundle = (
  bundle: ProjectMcpBundle,
  proof: ProjectMcpBundleProof,
): ProjectMcpBundle => {
  const frozen = Object.freeze(bundle);
  validatedMcpBundles.set(frozen, Object.freeze(proof));
  return frozen;
};

const declarationFingerprintInput = (declarations: Readonly<Record<string, ProjectMcpServer>>): unknown => ({
  schema: 'project-mcp-declaration.v1',
  servers: declarations,
});

const effectiveFingerprintInput = (
  bundle: {
    declarationFingerprint: string;
    endpointAuthorizations: ProjectMcpBundle['endpointAuthorizations'];
    launcherAuthorizations: ProjectMcpBundle['launcherAuthorizations'];
    servers: ProjectMcpBundle['servers'];
  },
  executables: Readonly<Record<string, ProjectMcpExecutableProof>>,
): unknown => ({
  schema: 'project-mcp-effective.v1',
  declarationFingerprint: bundle.declarationFingerprint,
  endpointAuthorizations: bundle.endpointAuthorizations,
  executables,
  launcherAuthorizations: bundle.launcherAuthorizations,
  servers: bundle.servers,
});

const requireValidatedBundle = (bundle: ProjectMcpBundle): ProjectMcpBundleProof => {
  const proof = bundle && validatedMcpBundles.get(bundle);
  if (!proof) {
    throw new ProjectMcpConfigError(
      bundle && typeof bundle.source === 'string' ? bundle.source : '<unknown MCP source>',
      'only bundles returned by the confined MCP loader, composition, or binding are accepted',
    );
  }
  if (bundle.declarationFingerprint !== hash(declarationFingerprintInput(proof.declarations))) {
    throw new ProjectMcpConfigError(
      bundle.source,
      'portable declaration fingerprint does not match its proof',
    );
  }
  if (bundle.effectiveFingerprint !== hash(effectiveFingerprintInput(bundle, proof.executables))) {
    throw new ProjectMcpConfigError(
      bundle.source,
      'effective fingerprint does not match local launch authority',
    );
  }
  return proof;
};

/**
 * Load exactly `<declarationRoot>/.mcp.json` (or the explicit confined filename). The root may be a
 * repository or a trusted Noriq-managed Codex/Claude environment. Parent directories, plugins,
 * vendor defaults, and personal config are never discovered implicitly. A missing file is a valid
 * empty bundle; a present malformed file is a costless prepare failure, never silent fallback.
 */
export async function loadMcpBundle(
  declarationRoot: string,
  options: ProjectMcpLoadOptions = {},
): Promise<ProjectMcpBundle> {
  const configuredDeclarationRoot = path.resolve(declarationRoot);
  const canonicalDeclarationRoot = await realpath(configuredDeclarationRoot);
  const declarationRootAliases = [...new Set([configuredDeclarationRoot, canonicalDeclarationRoot])];
  const implicitPathBinding = options.implicitPathBinding ?? 'workspace';
  if (implicitPathBinding !== 'workspace' && implicitPathBinding !== 'policy') {
    throw new Error("project MCP implicitPathBinding must be 'workspace' or 'policy'");
  }
  const source = options.filename
    ? path.isAbsolute(options.filename)
      ? options.filename
      : path.resolve(configuredDeclarationRoot, options.filename)
    : path.join(configuredDeclarationRoot, '.mcp.json');
  let text: string;
  try {
    const handle = await openConfined(source, declarationRoot);
    try {
      const size = (await handle.stat()).size;
      const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new Error('maxBytes must be a non-negative safe integer');
      }
      if (size > maxBytes) {
        throw new ProjectMcpConfigError(source, `is ${size} bytes; maximum is ${maxBytes}`);
      }
      text = (await handle.readFile()).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const declarations = freezeServers({});
      const launcherAuthorizations = Object.freeze({});
      const endpointAuthorizations = Object.freeze({});
      const servers = freezeServers({});
      const declarationFingerprint = hash(declarationFingerprintInput(declarations));
      const effectiveFingerprint = hash(
        effectiveFingerprintInput(
          {
            declarationFingerprint,
            endpointAuthorizations,
            launcherAuthorizations,
            servers,
          },
          {},
        ),
      );
      return finalizeValidatedBundle(
        {
          source,
          declarationFingerprint,
          effectiveFingerprint,
          launcherAuthorizations,
          endpointAuthorizations,
          servers,
        },
        {
          phase: 'portable',
          declarations,
          executables: freezeExecutableProofs({}),
        },
      );
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ProjectMcpConfigError(source, `JSON parse failed: ${(error as Error).message}`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    throw new ProjectMcpConfigError(source, 'root must contain an mcpServers object');
  }
  requireExactKeys(parsed, ['mcpServers'], 'root', source);

  const entries = Object.entries(parsed.mcpServers);
  const maxServers = options.maxServers ?? DEFAULT_MAX_SERVERS;
  if (!Number.isSafeInteger(maxServers) || maxServers < 0) {
    throw new Error('maxServers must be a non-negative safe integer');
  }
  if (entries.length > maxServers) {
    throw new ProjectMcpConfigError(source, `declares ${entries.length} servers; maximum is ${maxServers}`);
  }

  const reserved = new Set([...RUNNER_RESERVED_SERVERS, ...(options.reservedNames ?? [])]);
  const servers: Record<string, ProjectMcpServer> = {};
  const declarations: Record<string, ProjectMcpServer> = {};
  const launcherAuthorizations: Record<string, ProjectMcpLauncherAuthorization> = {};
  const executables: Record<string, ProjectMcpExecutableProof> = {};
  const endpointAuthorizations: Record<string, ProjectMcpEndpointAuthorization> = {};
  for (const [name, value] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!SERVER_NAME.test(name)) {
      throw new ProjectMcpConfigError(source, `server name '${name}' must match ${SERVER_NAME.source}`);
    }
    if (reserved.has(name)) {
      throw new ProjectMcpConfigError(source, `server name '${name}' is reserved by Runner`);
    }
    if (UNSAFE_OBJECT_KEYS.has(name)) {
      throw new ProjectMcpConfigError(source, `server name '${name}' is unsafe`);
    }
    const normalized = await normalizeServer(
      name,
      value,
      source,
      declarationRootAliases,
      implicitPathBinding,
      options.launcherPolicy,
      options.endpointPolicy,
    );
    servers[name] = normalized.server;
    declarations[name] = normalized.declaration;
    if (normalized.launcherAuthorization) {
      launcherAuthorizations[name] = normalized.launcherAuthorization;
    }
    if (normalized.executableProof) executables[name] = normalized.executableProof;
    if (normalized.endpointAuthorization) {
      endpointAuthorizations[name] = normalized.endpointAuthorization;
    }
  }

  const frozenAuthorizations = Object.freeze(launcherAuthorizations);
  const frozenEndpointAuthorizations = Object.freeze(endpointAuthorizations);
  const frozenServers = freezeServers(servers);
  const frozenDeclarations = freezeServers(declarations);
  const frozenExecutables = freezeExecutableProofs(executables);
  const declarationFingerprint = hash(declarationFingerprintInput(frozenDeclarations));
  const effectiveFingerprint = hash(
    effectiveFingerprintInput(
      {
        declarationFingerprint,
        endpointAuthorizations: frozenEndpointAuthorizations,
        launcherAuthorizations: frozenAuthorizations,
        servers: frozenServers,
      },
      frozenExecutables,
    ),
  );

  return finalizeValidatedBundle(
    {
      source,
      declarationFingerprint,
      effectiveFingerprint,
      launcherAuthorizations: frozenAuthorizations,
      endpointAuthorizations: frozenEndpointAuthorizations,
      servers: frozenServers,
    },
    {
      phase: 'portable',
      declarations: frozenDeclarations,
      executables: frozenExecutables,
    },
  );
}

/** Backwards-compatible repository spelling for callers which load only a project's root file. */
export function loadProjectMcpBundle(
  projectRoot: string,
  options: ProjectMcpLoadOptions = {},
): Promise<ProjectMcpBundle> {
  return loadMcpBundle(projectRoot, options);
}

/**
 * Combine explicit, independently confined MCP declarations into one portable transport bundle.
 * Composition is order-independent, rejects every server-name collision, and never infers tool
 * permission from presence. Each execution profile must still grant an exact server/tool subset.
 * Compose before workspace binding so the declaration fingerprint remains portable.
 */
export function composeMcpBundles(
  bundles: readonly ProjectMcpBundle[],
  options: McpBundleCompositionOptions = {},
): ProjectMcpBundle {
  const maxBundles = options.maxBundles ?? DEFAULT_MAX_BUNDLES;
  const maxServers = options.maxServers ?? DEFAULT_MAX_SERVERS;
  if (!Number.isSafeInteger(maxBundles) || maxBundles < 0) {
    throw new Error('maxBundles must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(maxServers) || maxServers < 0) {
    throw new Error('maxServers must be a non-negative safe integer');
  }
  if (bundles.length > maxBundles) {
    throw new ProjectMcpConfigError(
      '<MCP composition>',
      `contains ${bundles.length} bundles; maximum is ${maxBundles}`,
    );
  }

  const reserved = new Set([...RUNNER_RESERVED_SERVERS, ...(options.reservedNames ?? [])]);
  const owners = new Map<string, string>();
  const serversByName = new Map<string, ProjectMcpServer>();
  const declarationsByName = new Map<string, ProjectMcpServer>();
  const launchersByName = new Map<string, ProjectMcpLauncherAuthorization>();
  const executablesByName = new Map<string, ProjectMcpExecutableProof>();
  const endpointsByName = new Map<string, ProjectMcpEndpointAuthorization>();
  const sources: string[] = [];

  for (const bundle of bundles) {
    const source =
      bundle && typeof bundle.source === 'string' && bundle.source.length > 0
        ? bundle.source
        : '<unknown MCP source>';
    const proof = requireValidatedBundle(bundle);
    if (proof.phase !== 'portable') {
      throw new ProjectMcpConfigError(
        source,
        'bundle is already workspace-bound; compose portable declarations before binding',
      );
    }
    sources.push(source);

    for (const name of Object.keys(bundle.servers).sort()) {
      if (reserved.has(name)) {
        throw new ProjectMcpConfigError(source, `server name '${name}' is reserved by Runner`);
      }
      const priorOwner = owners.get(name);
      if (priorOwner !== undefined) {
        throw new ProjectMcpConfigError(
          '<MCP composition>',
          `server name '${name}' collides between '${priorOwner}' and '${source}'`,
        );
      }
      owners.set(name, source);
      serversByName.set(name, bundle.servers[name]!);
      declarationsByName.set(name, proof.declarations[name]!);
      const launcher = bundle.launcherAuthorizations[name];
      const executable = proof.executables[name];
      const endpoint = bundle.endpointAuthorizations[name];
      if (launcher) launchersByName.set(name, launcher);
      if (executable) executablesByName.set(name, executable);
      if (endpoint) endpointsByName.set(name, endpoint);
    }
  }

  if (serversByName.size > maxServers) {
    throw new ProjectMcpConfigError(
      '<MCP composition>',
      `declares ${serversByName.size} aggregate servers; maximum is ${maxServers}`,
    );
  }

  const servers: Record<string, ProjectMcpServer> = {};
  const declarations: Record<string, ProjectMcpServer> = {};
  const launcherAuthorizations: Record<string, ProjectMcpLauncherAuthorization> = {};
  const executables: Record<string, ProjectMcpExecutableProof> = {};
  const endpointAuthorizations: Record<string, ProjectMcpEndpointAuthorization> = {};
  for (const name of [...serversByName.keys()].sort()) {
    servers[name] = serversByName.get(name)!;
    declarations[name] = declarationsByName.get(name)!;
    const launcher = launchersByName.get(name);
    const executable = executablesByName.get(name);
    const endpoint = endpointsByName.get(name);
    if (launcher) launcherAuthorizations[name] = launcher;
    if (executable) executables[name] = executable;
    if (endpoint) endpointAuthorizations[name] = endpoint;
  }
  const frozenServers = freezeServers(servers);
  const frozenDeclarations = freezeServers(declarations);
  const frozenLauncherAuthorizations = Object.freeze(launcherAuthorizations);
  const frozenExecutables = freezeExecutableProofs(executables);
  const frozenEndpointAuthorizations = Object.freeze(endpointAuthorizations);
  const declarationFingerprint = hash(declarationFingerprintInput(frozenDeclarations));
  const effectiveFingerprint = hash(
    effectiveFingerprintInput(
      {
        declarationFingerprint,
        endpointAuthorizations: frozenEndpointAuthorizations,
        launcherAuthorizations: frozenLauncherAuthorizations,
        servers: frozenServers,
      },
      frozenExecutables,
    ),
  );
  return finalizeValidatedBundle(
    {
      source:
        sources.length === 0
          ? '<empty MCP composition>'
          : `composed MCP declarations: ${[...sources].sort().join(', ')}`,
      declarationFingerprint,
      effectiveFingerprint,
      launcherAuthorizations: frozenLauncherAuthorizations,
      endpointAuthorizations: frozenEndpointAuthorizations,
      servers: frozenServers,
    },
    {
      phase: 'portable',
      declarations: frozenDeclarations,
      executables: frozenExecutables,
    },
  );
}

const bindWorkspace = (value: string, workspace: string): string =>
  value.replaceAll('${workspace}', workspace);

/**
 * Bind the portable `${workspace}` token at the last responsible moment, separately for every
 * child workspace. The portable declaration fingerprint remains stable across workspaces; the
 * effective fingerprint proves the exact, locally bound launch configuration.
 */
export function bindMcpBundle(bundle: ProjectMcpBundle, workspace: string): ProjectMcpBundle {
  if (!path.isAbsolute(workspace)) throw new Error('project MCP workspace must be an absolute path');
  const proof = requireValidatedBundle(bundle);
  if (proof.phase !== 'portable') {
    throw new ProjectMcpConfigError(
      bundle.source,
      'bundle is already workspace-bound; each child must bind the portable declaration exactly once',
    );
  }
  const servers: Record<string, ProjectMcpServer> = {};
  for (const [name, server] of Object.entries(bundle.servers)) {
    servers[name] =
      server.transport === 'stdio'
        ? {
            transport: 'stdio',
            command: bindWorkspace(server.command, workspace),
            args: server.args.map((item) => bindWorkspace(item, workspace)),
            env: Object.fromEntries(
              Object.entries(server.env).map(([key, value]) => [key, bindWorkspace(value, workspace)]),
            ),
          }
        : {
            transport: server.transport,
            url: bindWorkspace(server.url, workspace),
            headers: Object.fromEntries(
              Object.entries(server.headers).map(([key, value]) => [key, bindWorkspace(value, workspace)]),
            ),
          };
  }
  const frozen = freezeServers(servers);
  const effectiveFingerprint = hash(
    effectiveFingerprintInput(
      {
        declarationFingerprint: bundle.declarationFingerprint,
        endpointAuthorizations: bundle.endpointAuthorizations,
        launcherAuthorizations: bundle.launcherAuthorizations,
        servers: frozen,
      },
      proof.executables,
    ),
  );
  return finalizeValidatedBundle(
    {
      ...bundle,
      effectiveFingerprint,
      servers: frozen,
    },
    {
      phase: 'bound',
      declarations: proof.declarations,
      executables: proof.executables,
    },
  );
}

export interface ProjectMcpExecutableAttestation {
  serverName: string;
  resolvedCommand: string;
  executableSha256: string;
  readOnlyRoots: readonly string[];
}

/**
 * Re-attest the exact local executable authority after session grants are resolved and immediately
 * before the containing vendor process is spawned. This catches command replacement, symlink
 * retargeting, executable-bit removal, runtime-root replacement, and forged/copy-constructed
 * bundles without teaching Runner anything about the declared MCP domain.
 *
 * `activeServerNames` should be the validated session's granted server order. Remote transports
 * are structurally revalidated but have no local executable to attest.
 */
export function reattestProjectMcpExecutablesSync(
  bundle: ProjectMcpBundle,
  activeServerNames: readonly string[] = Object.keys(bundle.servers).sort(),
): readonly ProjectMcpExecutableAttestation[] {
  const proof = requireValidatedBundle(bundle);
  if (
    !Array.isArray(activeServerNames) ||
    activeServerNames.length > DEFAULT_MAX_SERVERS ||
    new Set(activeServerNames).size !== activeServerNames.length
  ) {
    throw new ProjectMcpConfigError(bundle.source, 'active MCP server names must be a bounded unique array');
  }

  const attestations: ProjectMcpExecutableAttestation[] = [];
  for (const serverName of activeServerNames) {
    if (typeof serverName !== 'string' || !Object.hasOwn(bundle.servers, serverName)) {
      throw new ProjectMcpConfigError(
        bundle.source,
        `cannot attest undeclared MCP server '${String(serverName)}'`,
      );
    }
    const server = bundle.servers[serverName]!;
    if (server.transport !== 'stdio') continue;
    const authorization = bundle.launcherAuthorizations[serverName];
    const expected = proof.executables[serverName];
    if (!authorization || !expected) {
      throw new ProjectMcpConfigError(bundle.source, `stdio server '${serverName}' has no executable proof`);
    }

    try {
      const canonicalCommand = realpathSync(authorization.resolvedCommand);
      if (
        canonicalCommand !== authorization.resolvedCommand ||
        canonicalCommand !== expected.resolvedCommand
      ) {
        throw new Error('resolved command identity changed');
      }
      const commandStat = statSync(canonicalCommand);
      if (!commandStat.isFile()) throw new Error('resolved command is not a file');
      if ((commandStat.mode & (constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH)) === 0) {
        throw new Error('resolved command is not executable');
      }
      const executableSha256 = createHash('sha256').update(readFileSync(canonicalCommand)).digest('hex');
      if (executableSha256 !== expected.executableSha256) {
        throw new Error('resolved command digest changed');
      }

      for (let index = 0; index < expected.readOnlyRoots.length; index += 1) {
        const expectedRoot = expected.readOnlyRoots[index]!;
        if (authorization.readOnlyRoots[index] !== expectedRoot) {
          throw new Error(`read-only runtime root ${index} authority changed`);
        }
        const canonicalRoot = realpathSync(expectedRoot);
        const rootStat = statSync(canonicalRoot);
        if (canonicalRoot !== expectedRoot || !rootStat.isDirectory()) {
          throw new Error(`read-only runtime root ${index} identity changed`);
        }
      }
      if (authorization.readOnlyRoots.length !== expected.readOnlyRoots.length) {
        throw new Error('read-only runtime root authority changed');
      }

      attestations.push(
        Object.freeze({
          serverName,
          resolvedCommand: canonicalCommand,
          executableSha256,
          readOnlyRoots: Object.freeze([...expected.readOnlyRoots]),
        }),
      );
    } catch (error) {
      throw new ProjectMcpConfigError(
        bundle.source,
        `stdio server '${serverName}' executable re-attestation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return Object.freeze(attestations);
}

/** Async convenience wrapper for preparation code; synchronous drivers use the exact core above. */
export async function reattestProjectMcpExecutables(
  bundle: ProjectMcpBundle,
  activeServerNames?: readonly string[],
): Promise<readonly ProjectMcpExecutableAttestation[]> {
  return reattestProjectMcpExecutablesSync(bundle, activeServerNames);
}

/** Backwards-compatible repository spelling for existing mission-runtime callers. */
export function bindProjectMcpBundle(bundle: ProjectMcpBundle, workspace: string): ProjectMcpBundle {
  return bindMcpBundle(bundle, workspace);
}
