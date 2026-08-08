import { describe, expect, it } from 'vitest';
import { isDeniedIndexPath } from '../src/index-deny';

// RUN-209. Coverage over REAL secret-bearing paths a repo could plausibly carry, plus the
// no-re-include proof: `isDeniedIndexPath` takes no include/exclude input at all, so there is
// nothing a manifest could pass it to change the answer.

describe('isDeniedIndexPath — dotenv files', () => {
  it.each(['.env', '.env.local', '.env.production', 'config/.env', 'a/b/.env.test'])('denies %s', (p) => {
    expect(isDeniedIndexPath(p)).not.toBeNull();
  });

  it('does not deny a file that merely contains "env" in its name', () => {
    expect(isDeniedIndexPath('src/environment.ts')).toBeNull();
    expect(isDeniedIndexPath('envelope.md')).toBeNull();
  });
});

describe('isDeniedIndexPath — key material', () => {
  it.each([
    'id_rsa',
    'id_rsa.pub',
    'id_ed25519',
    'id_ed25519.pub',
    'id_ecdsa',
    'id_dsa',
    'keys/id_rsa',
    'certs/server.pem',
    'private.key',
    'bundle.p12',
    'bundle.pfx',
    'store.jks',
    'store.keystore',
  ])('denies %s', (p) => {
    expect(isDeniedIndexPath(p)).not.toBeNull();
  });

  it('does not deny an ordinary source file sharing a substring with a key extension', () => {
    expect(isDeniedIndexPath('src/keyboard.ts')).toBeNull();
    expect(isDeniedIndexPath('docs/keys.md')).toBeNull();
  });
});

describe('isDeniedIndexPath — credential directories, at any depth', () => {
  it.each([
    '.ssh/id_rsa',
    '.ssh/config',
    'nested/.ssh/known_hosts',
    '.aws/credentials',
    'tools/.aws/config',
    '.azure/foo',
    '.gcloud/bar',
    '.kube/config',
    'a/b/c/.kube/config',
  ])('denies %s', (p) => {
    expect(isDeniedIndexPath(p)).not.toBeNull();
  });
});

describe('isDeniedIndexPath — VCS internals', () => {
  it.each([
    '.git/HEAD',
    '.git/config',
    'a/.git/objects/x',
    '.hg/store',
    '.svn/entries',
    '.p4root/x',
    '.diversion/x',
  ])('denies %s', (p) => {
    expect(isDeniedIndexPath(p)).not.toBeNull();
  });
});

describe('isDeniedIndexPath — shell/package credentials and daemon state', () => {
  it.each([
    '.netrc',
    '.npmrc',
    '.pypirc',
    '.p4config',
    '.docker/config.json',
    '.noriq/credentials.json', // caught by the generic credentials*.json pattern
    '.noriq/parked-runs.json',
    'credentials.json',
    'nested/credentials-prod.json',
    'secrets.yaml',
    'secrets/db.txt',
  ])('denies %s', (p) => {
    expect(isDeniedIndexPath(p)).not.toBeNull();
  });
});

// The line explicitly drawn in the execution spec: `.noriq/project.toml` and
// `.noriq/workflows/*.toml` are committed config this daemon already trusts, not secrets.
describe('isDeniedIndexPath — explicitly NOT denied', () => {
  it.each(['.noriq/project.toml', '.noriq/workflows/build.toml', '.noriq/workflows/verify.toml'])(
    'does not deny %s',
    (p) => {
      expect(isDeniedIndexPath(p)).toBeNull();
    },
  );

  it('does not deny ordinary source files', () => {
    expect(isDeniedIndexPath('src/index.ts')).toBeNull();
    expect(isDeniedIndexPath('README.md')).toBeNull();
    expect(isDeniedIndexPath('package.json')).toBeNull();
  });
});

describe('isDeniedIndexPath — case insensitivity', () => {
  it.each([
    '.ENV',
    '.Env.Local',
    'ID_RSA',
    'Keys/ID_ED25519',
    'CERTS/SERVER.PEM',
    '.SSH/id_rsa',
    '.Git/HEAD',
  ])('denies %s exactly as it would deny the lowercase spelling', (p) => {
    expect(isDeniedIndexPath(p)).not.toBeNull();
  });
});

describe('isDeniedIndexPath — separator normalisation', () => {
  it('denies a backslash-spelled path the same as its forward-slash spelling', () => {
    expect(isDeniedIndexPath('.ssh\\id_rsa')).not.toBeNull();
    expect(isDeniedIndexPath('nested\\.git\\HEAD')).not.toBeNull();
  });
});

// The no-re-include proof: the function's own signature takes no include/exclude/override input,
// so there is no argument that could make it answer differently for the same path.
describe('isDeniedIndexPath — no override input exists', () => {
  it('has arity 1 — nothing to pass an include/exclude override through', () => {
    expect(isDeniedIndexPath.length).toBe(1);
  });

  it('returns the identical verdict regardless of how many times, or in what context, it is asked', () => {
    const a = isDeniedIndexPath('.env');
    const b = isDeniedIndexPath('.env');
    expect(a).toEqual(b);
    expect(a).not.toBeNull();
  });
});
