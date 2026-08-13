import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateProjectMcpSession } from '../src/drivers/types';
import {
  type ProjectMcpLauncherPolicy,
  bindMcpBundle,
  bindProjectMcpBundle,
  composeMcpBundles,
  loadMcpBundle,
  loadProjectMcpBundle,
  reattestProjectMcpExecutables,
} from '../src/project-mcp';

let dir: string;
let outside: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-project-mcp-'));
  outside = await mkdtemp(path.join(os.tmpdir(), 'noriq-project-mcp-out-'));
});
afterEach(async () => {
  await Promise.all([
    rm(dir, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]);
});

const put = (value: unknown) => writeFile(path.join(dir, '.mcp.json'), `${JSON.stringify(value)}\n`);
const putAt = (root: string, value: unknown) =>
  writeFile(path.join(root, '.mcp.json'), `${JSON.stringify(value)}\n`);
const sealedTestLauncherPolicy: ProjectMcpLauncherPolicy = {
  policyId: 'test-sealed-launcher-v1',
  authorize: (request) => {
    let packageIndex = 0;
    while (request.args[packageIndex] === '-y' || request.args[packageIndex] === '--yes') packageIndex += 1;
    if (request.command !== 'npx' || request.args[packageIndex] !== 'example-mcp@1.2.3') return null;
    // This fixture models a machine policy which has deliberately evaluated every argument. An
    // environment declaration may name only an explicit leased-workspace path; bare values which
    // could become cwd-relative files are not part of its authorized vector.
    if (
      request.argumentBinding === 'policy' &&
      request.args.slice(packageIndex + 1).some((argument) => !argument.startsWith('${workspace}'))
    ) {
      return null;
    }
    return {
      policyId: 'test-sealed-launcher-v1',
      executableIdentity: 'test:sealed-entrypoint-v1',
      runtimeClosureIdentity: 'test:sealed-runtime-v1',
      authorizedArgvIdentity: request.argvIdentity,
      resolvedCommand: process.execPath,
      readOnlyRoots: [],
    };
  },
};
const endpointPolicy = {
  policyId: 'test-exact-https-v1',
  authorize: ({ declaredUrl }: { declaredUrl: string }) => ({
    policyId: 'test-exact-https-v1',
    endpointIdentity: `test-endpoint:${declaredUrl}`,
    resolvedUrl: declaredUrl,
  }),
};
const load = (options: Parameters<typeof loadProjectMcpBundle>[1] = {}) =>
  loadProjectMcpBundle(dir, { launcherPolicy: sealedTestLauncherPolicy, endpointPolicy, ...options });

describe('loadProjectMcpBundle', () => {
  it('treats a missing project declaration as an empty, deterministic bundle', async () => {
    const first = await load();
    const second = await load();
    expect(first.servers).toEqual({});
    expect(first.endpointAuthorizations).toEqual({});
    expect(first.declarationFingerprint).toBe(second.declarationFingerprint);
    expect(first.effectiveFingerprint).toBe(second.effectiveFingerprint);
  });

  it('normalizes stdio and remote servers without domain-specific knowledge', async () => {
    await put({
      mcpServers: {
        simulator: { command: 'npx', args: ['-y', 'example-mcp@1.2.3'] },
        docs: { type: 'http', url: 'https://example.test/mcp' },
      },
    });

    const bundle = await load();
    expect(bundle.servers).toEqual({
      docs: {
        transport: 'http',
        url: 'https://example.test/mcp',
        headers: {},
      },
      simulator: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'example-mcp@1.2.3'],
        env: {},
      },
    });
    expect(Object.isFrozen(bundle.servers)).toBe(true);
    expect(Object.isFrozen(bundle.servers.simulator)).toBe(true);
  });

  it('binds the portable workspace token independently for each child workspace', async () => {
    await put({
      mcpServers: {
        simulator: {
          command: 'npx',
          args: ['-y', 'example-mcp@1.2.3', path.join(dir, 'Project.uproject')],
        },
      },
    });
    const declared = await load();
    const child = bindProjectMcpBundle(declared, '/leases/child-2');

    expect(child.servers.simulator).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'example-mcp@1.2.3', '/leases/child-2/Project.uproject'],
      env: {},
    });
    expect(declared.servers.simulator).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'example-mcp@1.2.3', '${workspace}/Project.uproject'],
      env: {},
    });
    expect(child.declarationFingerprint).toBe(declared.declarationFingerprint);
    expect(child.effectiveFingerprint).not.toBe(declared.effectiveFingerprint);
  });

  it('normalizes confined relative project arguments', async () => {
    await put({
      mcpServers: {
        local: {
          command: 'npx',
          args: ['example-mcp@1.2.3', './config.json'],
        },
      },
    });

    const declared = await load();
    expect(declared.servers.local).toMatchObject({
      command: 'npx',
      args: ['example-mcp@1.2.3', '${workspace}/config.json'],
    });
  });

  it.each([
    './environment-owned-config.json',
    'environment-owned-config.json',
    '--config=environment-owned-config.json',
  ])(
    'requires machine policy to authorize the complete agent-environment argv containing %s',
    async (argument) => {
      await put({
        mcpServers: {
          local: {
            command: 'npx',
            args: ['example-mcp@1.2.3', argument],
          },
        },
      });

      await expect(load({ implicitPathBinding: 'policy' })).rejects.toThrow(
        "executable was not authorized by trusted policy 'test-sealed-launcher-v1'",
      );
    },
  );

  it('rejects a policy response which did not attest the complete argv identity', async () => {
    await put({
      mcpServers: {
        local: { command: 'custom', args: ['--config', 'environment-owned-config.json'] },
      },
    });

    await expect(
      load({
        implicitPathBinding: 'policy',
        launcherPolicy: {
          policyId: 'command-only-policy',
          authorize: () => ({
            policyId: 'command-only-policy',
            executableIdentity: 'test:command-only-entrypoint',
            runtimeClosureIdentity: 'test:command-only-runtime',
            authorizedArgvIdentity: `sha256:${'0'.repeat(64)}`,
            resolvedCommand: process.execPath,
            readOnlyRoots: [],
          }),
        },
      }),
    ).rejects.toThrow('did not authorize the complete argv identity');
  });

  it('allows an agent environment to refer to the leased project only with an explicit token', async () => {
    await put({
      mcpServers: {
        local: {
          command: 'npx',
          args: ['example-mcp@1.2.3', '${workspace}/Project.file'],
        },
      },
    });

    const declared = await load({ implicitPathBinding: 'policy' });
    expect(declared.servers.local).toMatchObject({
      args: ['example-mcp@1.2.3', '${workspace}/Project.file'],
    });
  });

  it('normalizes an absolute argument written through a symlinked project-root spelling', async () => {
    const linkedRoot = path.join(outside, 'project-root-link');
    await symlink(dir, linkedRoot, 'dir');
    await put({
      mcpServers: {
        local: {
          command: 'npx',
          args: ['example-mcp@1.2.3', path.join(linkedRoot, 'Project.uproject')],
        },
      },
    });

    const declared = await loadProjectMcpBundle(linkedRoot, {
      launcherPolicy: sealedTestLauncherPolicy,
      endpointPolicy,
    });
    expect(declared.servers.local).toMatchObject({
      args: ['example-mcp@1.2.3', '${workspace}/Project.uproject'],
    });
  });

  it.each([
    ['bash', 'was not authorized by trusted policy'],
    ['node', 'was not authorized by trusted policy'],
    ['./tools/server', 'bare executable name'],
    ['/usr/bin/npx', 'bare executable name'],
  ])('refuses untrusted stdio launcher %s', async (command, detail) => {
    await put({ mcpServers: { tool: { command, args: ['example-mcp@1.2.3'] } } });
    await expect(load()).rejects.toThrow(detail);
  });

  it.each([
    [
      {
        mcpServers: {
          service: {
            command: 'npx',
            args: ['example-mcp@1.2.3'],
            env: { TOKEN: 'repo-secret' },
          },
        },
      },
      'literal credentials',
    ],
    [
      { mcpServers: { service: { url: 'https://example.test/mcp', headers: { Authorization: 'secret' } } } },
      'literal credentials',
    ],
  ])('refuses repository-carried process and HTTP credentials %#', async (config, detail) => {
    await put(config);
    await expect(load()).rejects.toThrow(detail);
  });

  it('fingerprints equivalent declarations independently of object key order', async () => {
    await put({
      mcpServers: {
        b: { command: 'npx', args: ['example-mcp@1.2.3', 'two', 'one'] },
        a: { type: 'http', url: 'https://example.test/mcp' },
      },
    });
    const first = await load();
    await put({
      mcpServers: {
        a: { url: 'https://example.test/mcp', type: 'http' },
        b: { args: ['example-mcp@1.2.3', 'two', 'one'], command: 'npx' },
      },
    });
    const second = await load();
    expect(first.declarationFingerprint).toBe(second.declarationFingerprint);
    expect(first.effectiveFingerprint).toBe(second.effectiveFingerprint);
  });

  it.each([
    [{}, 'root must contain an mcpServers object'],
    [{ mcpServers: { noriq: { command: 'shadow' } } }, "server name 'noriq' is reserved"],
    [{ mcpServers: { codex_apps: { command: 'shadow' } } }, "server name 'codex_apps' is reserved"],
    [{ mcpServers: { bad: { command: 'x', url: 'https://x.test' } } }, 'exactly one of command'],
    [{ mcpServers: { 'bad.name': { command: 'x' } } }, 'must match'],
    [{ mcpServers: { bad: { type: 'http', command: 'x' } } }, "type must be 'stdio'"],
    [{ mcpServers: {}, typo: true }, "root contains unsupported field 'typo'"],
    [{ mcpServers: { bad: { command: 'x', arg: [] } } }, "contains unsupported field 'arg'"],
    [{ mcpServers: { ['__proto__']: { command: 'x' } } }, "server name '__proto__' is unsafe"],
  ])('fails closed for malformed declarations %#', async (config, detail) => {
    await put(config);
    await expect(load()).rejects.toThrow(detail);
  });

  it('bounds the number of processes a declaration can request', async () => {
    await put({ mcpServers: { a: { command: 'a' }, b: { command: 'b' } } });
    await expect(load({ maxServers: 1 })).rejects.toThrow('maximum is 1');
  });

  it('bounds declaration bytes before parsing', async () => {
    await writeFile(path.join(dir, '.mcp.json'), ' '.repeat(32));
    await expect(load({ maxBytes: 8 })).rejects.toThrow('maximum is 8');
  });

  it.each([
    ['example-mcp@latest', 'mutable executable selector'],
    ['example-mcp', 'was not authorized by trusted policy'],
    ['@scope/example-mcp', 'was not authorized by trusted policy'],
    ['example-mcp@^1.2.3', 'was not authorized by trusted policy'],
    ['example-mcp@1.2', 'was not authorized by trusted policy'],
  ])(
    'leaves package selection to the injected immutable launcher policy for %s',
    async (selector, detail) => {
      await put({ mcpServers: { tool: { command: 'npx', args: ['-y', selector] } } });
      await expect(load()).rejects.toThrow(detail);
    },
  );

  it.each([
    [['-y'], 'was not authorized by trusted policy'],
    [['--package=example-mcp@latest', 'example-bin'], 'mutable executable selector'],
    [['--package', 'example-mcp@latest', 'example-bin'], 'mutable executable selector'],
    [['--package=example-mcp@1.2.3', 'example-bin'], 'was not authorized by trusted policy'],
    [['--package', 'example-mcp@1.2.3', 'example-bin'], 'was not authorized by trusted policy'],
  ])('refuses argv outside the complete vector selected by machine policy %#', async (args, detail) => {
    await put({ mcpServers: { tool: { command: 'npx', args } } });
    await expect(load()).rejects.toThrow(detail);
  });

  it.each([
    '${workspace}/../outside/server',
    '${workspace}/safe\\..\\..\\outside',
    '${workspace}//server',
    'prefix/${workspace}/server',
  ])('refuses an unconfined workspace placeholder in %s', async (command) => {
    await put({ mcpServers: { tool: { command: 'npx', args: ['example-mcp@1.2.3', command] } } });
    await expect(load()).rejects.toThrow('not a confined path');
  });

  it.each(['../outside/server', '--config=../outside.json', 'nested/../../outside'])(
    'refuses relative argument traversal in %s',
    async (argument) => {
      await put({
        mcpServers: { tool: { command: 'npx', args: ['example-mcp@1.2.3', argument] } },
      });
      await expect(load()).rejects.toThrow('path traversal');
    },
  );

  it.each([
    ['file:///tmp/server', 'credential-free HTTPS'],
    ['http://example.test/mcp', 'credential-free HTTPS'],
    ['https://user:secret@example.test/mcp', 'credential-free HTTPS'],
    ['https://example.test/mcp?token=repo-secret', 'credential-free HTTPS'],
    ['https://127.0.0.1/mcp', 'local, private, or link-local'],
    ['https://169.254.169.254/latest/meta-data', 'local, private, or link-local'],
    ['https://[::1]/mcp', 'local, private, or link-local'],
    ['https://[fe80::1]/mcp', 'local, private, or link-local'],
    ['https://[::ffff:127.0.0.1]/mcp', 'local, private, or link-local'],
    ['https://[::ffff:a00:1]/mcp', 'local, private, or link-local'],
    ['https://[::ffff:c0a8:1]/mcp', 'local, private, or link-local'],
    ['https://[fec0::1]/mcp', 'local, private, or link-local'],
    ['https://example.test/${workspace}', 'may not expose'],
  ])('refuses unsafe remote MCP URLs %#', async (url, detail) => {
    await put({ mcpServers: { remote: { type: 'http', url } } });
    await expect(load()).rejects.toThrow(detail);
  });

  it('refuses absolute arguments outside the project root', async () => {
    await put({
      mcpServers: {
        tool: { command: 'npx', args: ['example-mcp@1.2.3', path.join(outside, 'Project.file')] },
      },
    });
    await expect(load()).rejects.toThrow('outside the selected declaration root');
  });

  it('refuses a project declaration symlinked outside the leased workspace', async () => {
    const target = path.join(outside, 'outside.json');
    await writeFile(target, JSON.stringify({ mcpServers: {} }));
    await symlink(target, path.join(dir, '.mcp.json'));
    await expect(load()).rejects.toThrow('outside the repo');
  });

  it('denies local execution when Runner supplies no trusted launcher policy', async () => {
    await put({ mcpServers: { tool: { command: 'npx', args: ['example-mcp@1.2.3'] } } });
    await expect(loadProjectMcpBundle(dir)).rejects.toThrow('no trusted launcher policy');
  });

  it('denies repository-declared network access without a trusted endpoint policy', async () => {
    await put({ mcpServers: { docs: { type: 'http', url: 'https://example.test/mcp' } } });
    await expect(loadProjectMcpBundle(dir)).rejects.toThrow('no trusted endpoint policy');
  });

  it('launches and fingerprints the endpoint resolved by trusted policy', async () => {
    await put({ mcpServers: { docs: { type: 'sse', url: 'https://alias.example.test/mcp' } } });
    const first = await load({
      endpointPolicy: {
        policyId: 'broker-policy-v1',
        authorize: () => ({
          policyId: 'broker-policy-v1',
          endpointIdentity: 'broker-cluster-a/revision-7',
          resolvedUrl: 'https://broker.example.test/project/docs',
        }),
      },
    });
    const second = await load({
      endpointPolicy: {
        policyId: 'broker-policy-v1',
        authorize: () => ({
          policyId: 'broker-policy-v1',
          endpointIdentity: 'broker-cluster-a/revision-8',
          resolvedUrl: 'https://broker.example.test/project/docs-v2',
        }),
      },
    });

    expect(first.servers.docs).toMatchObject({
      transport: 'sse',
      url: 'https://broker.example.test/project/docs',
    });
    expect(first.endpointAuthorizations.docs).toMatchObject({
      endpointIdentity: 'broker-cluster-a/revision-7',
      resolvedUrl: 'https://broker.example.test/project/docs',
    });
    expect(first.declarationFingerprint).toBe(second.declarationFingerprint);
    expect(first.effectiveFingerprint).not.toBe(second.effectiveFingerprint);
  });

  it('requires the complete launcher argv to be explicitly trusted', async () => {
    await put({ mcpServers: { tool: { command: 'npx', args: ['other-mcp@4.5.6'] } } });
    await expect(load()).rejects.toThrow('was not authorized by trusted policy');
  });

  it('accepts a generic injected digest policy for a bare non-npx launcher', async () => {
    await put({ mcpServers: { tool: { command: 'uvx', args: ['server==1.2.3'] } } });
    const bundle = await load({
      launcherPolicy: {
        policyId: 'test-uv-digest-v1',
        authorize: ({ command, args, argvIdentity }) =>
          command === 'uvx' && args[0] === 'server==1.2.3'
            ? {
                policyId: 'test-uv-digest-v1',
                executableIdentity: `sha256:${'c'.repeat(64)}`,
                runtimeClosureIdentity: 'test:sealed-uv-runtime-v1',
                authorizedArgvIdentity: argvIdentity,
                resolvedCommand: process.execPath,
                readOnlyRoots: [],
              }
            : null,
      },
    });
    expect(bundle.launcherAuthorizations.tool).toEqual({
      policyId: 'test-uv-digest-v1',
      executableIdentity: `sha256:${'c'.repeat(64)}`,
      runtimeClosureIdentity: 'test:sealed-uv-runtime-v1',
      authorizedArgvIdentity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      resolvedCommand: process.execPath,
      readOnlyRoots: [],
    });
  });

  it('keeps portable declaration identity stable across different local launcher authorities', async () => {
    await put({ mcpServers: { tool: { command: 'custom', args: ['server==1.2.3'] } } });
    const policy = (identity: string) => ({
      policyId: `test-policy-${identity}`,
      authorize: ({ argvIdentity }: { argvIdentity: string }) => ({
        policyId: `test-policy-${identity}`,
        executableIdentity: identity,
        runtimeClosureIdentity: `closure-${identity}`,
        authorizedArgvIdentity: argvIdentity,
        resolvedCommand: process.execPath,
        readOnlyRoots: [],
      }),
    });

    const first = await load({ launcherPolicy: policy('authority-a') });
    const second = await load({ launcherPolicy: policy('authority-b') });

    expect(first.declarationFingerprint).toBe(second.declarationFingerprint);
    expect(first.effectiveFingerprint).not.toBe(second.effectiveFingerprint);
  });

  it('re-attests the exact executable digest immediately before launch and rejects replacement', async () => {
    const executable = path.join(outside, 'project-mcp-launcher');
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o755);
    await put({ mcpServers: { tool: { command: 'custom', args: ['server==1.2.3'] } } });
    const launcherPolicy = {
      policyId: 'test-local-executable-v1',
      authorize: ({ argvIdentity }: { argvIdentity: string }) => ({
        policyId: 'test-local-executable-v1',
        executableIdentity: 'test-local-executable/revision-1',
        runtimeClosureIdentity: 'test-local-runtime/revision-1',
        authorizedArgvIdentity: argvIdentity,
        resolvedCommand: executable,
        readOnlyRoots: [],
      }),
    };
    const bundle = await load({ launcherPolicy });
    const bound = bindProjectMcpBundle(bundle, '/leases/mission-child');

    await expect(reattestProjectMcpExecutables(bound, ['tool'])).resolves.toEqual([
      expect.objectContaining({
        serverName: 'tool',
        resolvedCommand: executable,
        executableSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);

    await writeFile(executable, '#!/bin/sh\nexit 7\n');
    const replacement = await load({ launcherPolicy });
    expect(replacement.declarationFingerprint).toBe(bundle.declarationFingerprint);
    expect(replacement.effectiveFingerprint).not.toBe(bundle.effectiveFingerprint);
    await expect(reattestProjectMcpExecutables(bound, ['tool'])).rejects.toThrow(
      /executable re-attestation failed: resolved command digest changed/,
    );
  });

  it('re-attestation rejects forged bundles and undeclared selected servers', async () => {
    await put({ mcpServers: { docs: { type: 'http', url: 'https://example.test/mcp' } } });
    const bundle = await load();

    await expect(reattestProjectMcpExecutables({ ...bundle }, ['docs'])).rejects.toThrow(
      /only bundles returned by the confined MCP loader/,
    );
    await expect(reattestProjectMcpExecutables(bundle, ['missing'])).rejects.toThrow(
      /cannot attest undeclared MCP server 'missing'/,
    );
  });

  it('rejects flattened MCP tool-address collisions and reserved names in forged bundles', async () => {
    await put({
      mcpServers: {
        a: { type: 'http', url: 'https://a.example.test/mcp' },
        a__b: { type: 'http', url: 'https://b.example.test/mcp' },
      },
    });
    const bundle = await load();
    expect(() => validateProjectMcpSession({ bundle, toolGrants: { a: ['b__c'], a__b: ['c'] } })).toThrow(
      'flattened tool address',
    );

    expect(() =>
      validateProjectMcpSession({
        bundle: {
          ...bundle,
          servers: { noriq: bundle.servers.a! },
          endpointAuthorizations: { noriq: bundle.endpointAuthorizations.a! },
        },
        toolGrants: { noriq: ['claim_task'] },
      }),
    ).toThrow("server name 'noriq' is reserved");
  });

  it('rejects delimiter-bearing exact tool grants before a driver can serialize them', async () => {
    await put({
      mcpServers: {
        simulator: { type: 'http', url: 'https://simulator.example.test/mcp' },
      },
    });
    const bundle = await load();

    expect(() => validateProjectMcpSession({ bundle, toolGrants: { simulator: ['inspect,Bash'] } })).toThrow(
      'invalid exact tool name',
    );
  });
});

describe('generic MCP bundle composition', () => {
  it('loads environment and repository declarations through one path with exact downstream grants', async () => {
    await putAt(outside, {
      mcpServers: {
        environment_docs: { type: 'http', url: 'https://environment.example.test/mcp' },
      },
    });
    await put({
      mcpServers: {
        project_editor: {
          command: 'npx',
          args: ['example-mcp@1.2.3', '${workspace}/Project.file'],
        },
      },
    });

    const environment = await loadMcpBundle(outside, {
      launcherPolicy: sealedTestLauncherPolicy,
      endpointPolicy,
    });
    const project = await loadMcpBundle(dir, {
      launcherPolicy: sealedTestLauncherPolicy,
      endpointPolicy,
    });
    const composed = composeMcpBundles([environment, project]);

    expect(Object.keys(composed.servers)).toEqual(['environment_docs', 'project_editor']);
    expect(
      validateProjectMcpSession({
        bundle: composed,
        toolGrants: {
          environment_docs: ['search'],
          project_editor: ['inspect', 'edit'],
        },
      }),
    ).toEqual(['environment_docs', 'project_editor']);

    const bound = bindMcpBundle(composed, '/leases/mission-child');
    expect(bound.servers.project_editor).toMatchObject({
      args: ['example-mcp@1.2.3', '/leases/mission-child/Project.file'],
    });
  });

  it('produces one order-independent fingerprint from the merged validated authority', async () => {
    await putAt(outside, {
      mcpServers: {
        environment_docs: { type: 'http', url: 'https://environment.example.test/mcp' },
      },
    });
    await put({
      mcpServers: {
        project_docs: { type: 'http', url: 'https://project.example.test/mcp' },
      },
    });
    const environment = await loadMcpBundle(outside, { endpointPolicy });
    const project = await loadMcpBundle(dir, { endpointPolicy });

    const forward = composeMcpBundles([environment, project]);
    const reverse = composeMcpBundles([project, environment]);
    expect(forward.declarationFingerprint).toBe(reverse.declarationFingerprint);
    expect(forward.effectiveFingerprint).toBe(reverse.effectiveFingerprint);
    expect(forward.servers).toEqual(reverse.servers);
  });

  it('rejects a server collision instead of giving either declaration implicit override priority', async () => {
    await putAt(outside, {
      mcpServers: { shared: { type: 'http', url: 'https://environment.example.test/mcp' } },
    });
    await put({
      mcpServers: { shared: { type: 'http', url: 'https://project.example.test/mcp' } },
    });
    const environment = await loadMcpBundle(outside, { endpointPolicy });
    const project = await loadMcpBundle(dir, { endpointPolicy });

    expect(() => composeMcpBundles([environment, project])).toThrow("server name 'shared' collides between");
  });

  it('enforces aggregate composition bounds', async () => {
    await putAt(outside, {
      mcpServers: { environment: { type: 'http', url: 'https://environment.example.test/mcp' } },
    });
    await put({
      mcpServers: { project: { type: 'http', url: 'https://project.example.test/mcp' } },
    });
    const environment = await loadMcpBundle(outside, { endpointPolicy });
    const project = await loadMcpBundle(dir, { endpointPolicy });

    expect(() => composeMcpBundles([environment, project], { maxBundles: 1 })).toThrow(
      'contains 2 bundles; maximum is 1',
    );
    expect(() => composeMcpBundles([environment, project], { maxServers: 1 })).toThrow(
      '2 aggregate servers; maximum is 1',
    );
  });

  it('accepts only loader-proven portable bundles', async () => {
    await put({
      mcpServers: {
        project_editor: {
          command: 'npx',
          args: ['example-mcp@1.2.3', '${workspace}/Project.file'],
        },
      },
    });
    const project = await loadMcpBundle(dir, { launcherPolicy: sealedTestLauncherPolicy });

    expect(() => composeMcpBundles([{ ...project }])).toThrow(
      'only bundles returned by the confined MCP loader',
    );
    expect(() => composeMcpBundles([bindProjectMcpBundle(project, '/leases/child')])).toThrow(
      'compose portable declarations before binding',
    );
  });
});
