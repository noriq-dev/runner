import { describe, expect, it } from 'vitest';
import {
  keyLooksSensitive,
  looksHighEntropy,
  scanTextForCredentialMarkers,
  scanTextForSecretShapedContent,
  shouldWithholdValue,
  valueLooksSecret,
} from '../src/index-redact';

describe('keyLooksSensitive', () => {
  it.each([
    'token',
    'secret',
    'password',
    'passwd',
    'credential',
    'private_key',
    'api_key',
    'apiKey',
    'apikey',
    'auth',
    'bearer',
    'session',
    'cookie',
    'salt',
    'DB_PASSWORD', // case-insensitive
    'x-api-key', // punctuation-normalized
  ])('flags %s', (key) => {
    expect(keyLooksSensitive(key)).toBe(true);
  });

  it.each(['username', 'name', 'description', 'version', 'branch', 'port'])(
    'does not flag an ordinary key %s',
    (key) => {
      expect(keyLooksSensitive(key)).toBe(false);
    },
  );

  it('flags "author" — a documented false positive from the "auth" substring, and the correct side to err on', () => {
    // Per index-redact.ts's own module doc: this is a deliberate over-cautious hit, not a bug.
    // Losing an author's name to withholding costs nothing; the alternative (narrowing the
    // substring so "author" passes) would also let "authtoken", "authKey" etc. slip through.
    expect(keyLooksSensitive('author')).toBe(true);
  });
});

describe('valueLooksSecret', () => {
  it('flags a PEM private key header', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----';
    expect(valueLooksSecret(pem)).toMatch(/PEM/);
  });

  it('flags a JWT-shaped value', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(valueLooksSecret(jwt)).toMatch(/JWT/);
  });

  it.each([
    ['ghp_16C7e42F292c6912E7710c838347Ae178B4a', 'GitHub PAT'],
    ['gho_16C7e42F292c6912E7710c838347Ae178B4a', 'GitHub OAuth token'],
    [
      'github_pat_11AAAAAAA0aaaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'GitHub fine-grained PAT',
    ],
    ['sk-proj-abcdefghijklmnopqrstuvwxyz0123456789', 'OpenAI/Anthropic-style key'],
    ['xoxb-1234567890-abcdefghijklmnop', 'Slack bot token'],
    ['AKIAIOSFODNN7EXAMPLE', 'AWS access key id'],
    ['AIzaSyDaGmWKa4JsXZ-HjGw7ISLan_Amoqrkps0', 'Google API key'],
  ])('flags a known issuer prefix: %s (%s)', (value) => {
    expect(valueLooksSecret(value)).toMatch(/prefix/);
  });

  it('never embeds the matched value — or even its matched prefix — in the returned reason', () => {
    // Regression: the reason string used to interpolate the matched prefix
    // (`known credential prefix ("ghp_")`), which is exactly the fragment of the credential's own
    // bytes locked decision 3 says must never appear even in redacted form.
    const cases = [
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      'ghp_16C7e42F292c6912E7710c838347Ae178B4a',
      'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
      'Kj8xQ9Lm2Wz4Rt6Yh1Bv3Nc5Fh7Gd0SaP2mK9',
    ];
    for (const value of cases) {
      const reason = valueLooksSecret(value);
      expect(reason).not.toBeNull();
      expect(reason).not.toContain(value);
      expect(reason).not.toMatch(/ghp_|gho_|github_pat_|sk-|xox[abprs]-|AKIA|AIza/);
    }
  });

  it('flags a generated-looking high-entropy token', () => {
    expect(valueLooksSecret('Kj8xQ9Lm2Wz4Rt6Yh1Bv3Nc5Fh7Gd0SaP2mK9')).toMatch(/entropy/);
  });

  it('does not flag an ordinary URL', () => {
    const url = 'https://example.com/docs/getting-started/installation?ref=readme';
    expect(valueLooksSecret(url)).toBeNull();
  });

  it('does not flag a SHA-256 hex digest', () => {
    const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(valueLooksSecret(sha)).toBeNull();
  });

  it('does not flag a git commit SHA (40 hex chars)', () => {
    expect(valueLooksSecret('a94a8fe5ccb19ba61c4c0873d391e987982fbbd3')).toBeNull();
  });

  it('does not flag an SPDX/licence string', () => {
    const licence =
      'Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.';
    expect(valueLooksSecret(licence)).toBeNull();
  });

  it('does not flag an ordinary short value', () => {
    expect(valueLooksSecret('main')).toBeNull();
    expect(valueLooksSecret('8080')).toBeNull();
    expect(valueLooksSecret('true')).toBeNull();
  });

  it('does not flag an empty or whitespace-only value', () => {
    expect(valueLooksSecret('')).toBeNull();
    expect(valueLooksSecret('   ')).toBeNull();
  });
});

describe('looksHighEntropy — the stated threshold', () => {
  it('requires at least the minimum length', () => {
    expect(looksHighEntropy('Kj8xQ9Lm2Wz4')).toBe(false); // short, even if mixed-class
  });

  it('requires at least three character classes', () => {
    // Long and "random-looking" hex — only lowercase+digit (2 classes) — must never qualify,
    // BY CONSTRUCTION, regardless of the entropy number (this is what keeps a SHA from flagging).
    expect(looksHighEntropy('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).toBe(false);
  });

  it('flags a long, mixed-class, high-entropy string', () => {
    expect(looksHighEntropy('Kj8xQ9Lm2Wz4Rt6Yh1Bv3Nc5Fh7Gd0SaP2mK9')).toBe(true);
  });
});

describe('shouldWithholdValue', () => {
  it('withholds on a sensitive key name even for an innocuous-looking value', () => {
    expect(shouldWithholdValue('password', 'hunter2')).toMatch(/key name/);
  });

  it('withholds on a shaped value even for an innocuous-looking key', () => {
    expect(shouldWithholdValue('a', 'ghp_16C7e42F292c6912E7710c838347Ae178B4a')).toMatch(/prefix/);
  });

  it('passes through an ordinary key/value pair', () => {
    expect(shouldWithholdValue('branch', 'main')).toBeNull();
  });

  it('checks only the value when key is null (an array element)', () => {
    expect(shouldWithholdValue(null, 'main')).toBeNull();
    expect(shouldWithholdValue(null, 'ghp_16C7e42F292c6912E7710c838347Ae178B4a')).toMatch(/prefix/);
  });
});

describe('scanTextForSecretShapedContent', () => {
  it('flags a PEM header embedded in a larger blob', () => {
    const text = 'Here is a sample key:\n-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n';
    expect(scanTextForSecretShapedContent(text)).toMatch(/PEM/);
  });

  it('flags a known prefix embedded mid-sentence, e.g. an example .env line in a code block', () => {
    const text = 'API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789\nDEBUG=true';
    expect(scanTextForSecretShapedContent(text)).toMatch(/prefix/);
  });

  it('flags a high-entropy whitespace-delimited token in running prose', () => {
    const text = 'Set the token to Kj8xQ9Lm2Wz4Rt6Yh1Bv3Nc5Fh7Gd0SaP2mK9 before starting the server.';
    expect(scanTextForSecretShapedContent(text)).toMatch(/entropy/);
  });

  it('never embeds the matched prefix in the returned reason', () => {
    const text = 'API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789\nDEBUG=true';
    const reason = scanTextForSecretShapedContent(text);
    expect(reason).not.toBeNull();
    expect(reason).not.toMatch(/sk-proj/);
  });

  it('does not flag ordinary documentation prose', () => {
    const text =
      'Run `npm run check` before calling work done. It runs the typechecker, the linter, and the ' +
      'full test suite in sequence, and the whole thing normally finishes in under a minute.';
    expect(scanTextForSecretShapedContent(text)).toBeNull();
  });

  it('does not flag a paragraph containing only URLs and SHAs', () => {
    const text =
      'See https://example.com/docs/setup for details. The last known-good commit was ' +
      'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3.';
    expect(scanTextForSecretShapedContent(text)).toBeNull();
  });
});

describe('scanTextForCredentialMarkers — RUN-258, the marker-only whole-file entry point', () => {
  it('flags a PEM header anywhere in a larger file', () => {
    const text =
      'const key = `\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----\n`;';
    expect(scanTextForCredentialMarkers(text)).toMatch(/PEM/);
  });

  it('flags a JWT-shaped value anywhere in a larger file', () => {
    const text =
      'const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";';
    expect(scanTextForCredentialMarkers(text)).toMatch(/JWT/);
  });

  it.each([
    'const token = "ghp_16C7e42F292c6912E7710c838347Ae178B4a";',
    'const token = "gho_16C7e42F292c6912E7710c838347Ae178B4a";',
    'const key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";',
    'const bot = "xoxb-1234567890-abcdefghijklmnop";',
    'const id = "AKIAIOSFODNN7EXAMPLE";',
    'const key = "AIzaSyDaGmWKa4JsXZ-HjGw7ISLan_Amoqrkps0";',
  ])('flags a known issuer prefix at a real token boundary: %s', (text) => {
    expect(scanTextForCredentialMarkers(text)).toMatch(/prefix/);
  });

  it('never embeds the matched value or prefix in the returned reason', () => {
    const cases = [
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----',
      'const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.' +
        'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";',
      'const token = "ghp_16C7e42F292c6912E7710c838347Ae178B4a";',
    ];
    for (const text of cases) {
      const reason = scanTextForCredentialMarkers(text);
      expect(reason).not.toBeNull();
      expect(reason).not.toMatch(/ghp_|gho_|github_pat_|sk-|xox[abprs]-|AKIA|AIza|MIIEow|eyJ/);
    }
  });

  // The whole reason this function exists rather than reusing `scanTextForSecretShapedContent`
  // directly (locked decision 6): composing the VALUE-level checks over WHOLE FILES over-redacts.
  it('does NOT run the entropy heuristic — a high-entropy token with no known marker is left alone', () => {
    const text = 'const token = "Kj8xQ9Lm2Wz4Rt6Yh1Bv3Nc5Fh7Gd0SaP2mK9";';
    expect(scanTextForSecretShapedContent(text)).toMatch(/entropy/); // the VALUE-level scan DOES fire
    expect(scanTextForCredentialMarkers(text)).toBeNull(); // the marker-only scan does not
  });

  // The measured false positive locked decision 1 names: a plain substring match on `sk-` (the
  // naive composition this task explicitly rejects) fires inside ordinary English — `task-`,
  // `risk-`, `desk-` all contain the literal substring `sk-`. This is the exact shape that made
  // `src/adjudication.ts` lose its entire content under the naive alternative.
  it.each(['a task-completion helper', 'handles the risk-scoring path', 'render to the desk-view panel'])(
    'does not flag "sk-" embedded mid-word in ordinary English: %s',
    (text) => {
      expect(scanTextForCredentialMarkers(text)).toBeNull();
    },
  );

  it('still flags a real "sk-" token at a genuine word boundary, right after ordinary prose containing "task-"', () => {
    const text = 'a task-completion helper using key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
    expect(scanTextForCredentialMarkers(text)).toMatch(/prefix/);
  });

  it('does not flag ordinary documentation prose', () => {
    const text =
      'Run `npm run check` before calling work done. It runs the typechecker, the linter, and the ' +
      'full test suite in sequence, and the whole thing normally finishes in under a minute.';
    expect(scanTextForCredentialMarkers(text)).toBeNull();
  });

  it('does not flag an ordinary source file (a real one from this repo) with no credential in it', () => {
    // A short but representative excerpt — plain TypeScript, no secret-shaped content at all.
    const text = `
export function add(a: number, b: number): number {
  return a + b;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
`;
    expect(scanTextForCredentialMarkers(text)).toBeNull();
  });
});

describe('scanTextForCredentialMarkers — RUN-263, the payload discriminator', () => {
  // The measured bug this task fixes: THREAT-MODEL.md documents the marker vocabulary, and RUN-258's
  // marker-only check could not distinguish that from a file that actually contains a credential.
  // This is the real sentence from THREAT-MODEL.md's own `[index]` section, byte-for-byte.
  it("does not flag THREAT-MODEL.md's own list of bare issuer-prefix examples", () => {
    const text =
      'RUN-258 closes that specific gap for **unambiguous credential markers only** — PEM headers, ' +
      'JWTs, known issuer prefixes (`ghp_`, `sk-`, `AKIA`, …) — checked over the whole file.';
    expect(scanTextForCredentialMarkers(text)).toBeNull();
  });

  // The second measured false positive: this very module's own doc comment for `PEM_HEADER_RE`,
  // which quotes three bare BEGIN headers with no body and no END anywhere near them.
  it('does not flag a doc comment that quotes bare PEM BEGIN headers with no body or END', () => {
    const text =
      'A PEM-encoded key/certificate header — `-----BEGIN RSA PRIVATE KEY-----`, ' +
      '`-----BEGIN CERTIFICATE-----`, `-----BEGIN OPENSSH PRIVATE KEY-----`, and siblings.';
    expect(scanTextForCredentialMarkers(text)).toBeNull();
  });

  // A bare stub value with almost no payload — the same shape as this repo's own
  // `test/security.test.ts` fixture (`GITHUB_TOKEN: 'ghp_x'`), which RUN-258 withheld and RUN-263
  // must not.
  it('does not flag a short placeholder/stub value that carries no real payload', () => {
    const text = "const GITHUB_TOKEN = 'ghp_x';";
    expect(scanTextForCredentialMarkers(text)).toBeNull();
  });

  // JWT is left unmodified by this task (discretion point 2): a documentation placeholder's segments
  // are always shorter than the 10-char-per-segment floor `JWT_SEARCH_RE` already enforces, so it
  // already discriminates a mention from a real token without any change.
  it('does not flag a JWT-shaped mention with placeholder segments too short to be real', () => {
    const text = 'A JWT is three dot-separated base64url segments, shaped like header.payload.signature.';
    expect(scanTextForCredentialMarkers(text)).toBeNull();
  });

  // The payload requirement must not re-admit RUN-258's own fix: a bare prefix directly ADJACENT to
  // real payload-shaped characters (not just isolated documentation) still has to be caught, so the
  // boundary and payload checks are independent layers, not a single weaker one.
  it('still flags a real credential immediately preceded by prose using the same prefix letters', () => {
    const text = 'the risk-scoring task uses key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 internally';
    expect(scanTextForCredentialMarkers(text)).toMatch(/prefix/);
  });

  // A PEM BEGIN with a matching END but nothing at all between them (no body) is still just
  // structure being described, not a credential — the body requirement is real, not automatically
  // satisfied by the presence of a paired END.
  it('does not flag a PEM BEGIN/END pair with no body between them', () => {
    const text = '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n';
    expect(scanTextForCredentialMarkers(text)).toBeNull();
  });

  // A real PEM block — BEGIN, a base64 body, a matching END — must still be withheld; this is the
  // planted-credential regression pin for the PEM class specifically (locked decision 2).
  it('still flags a real PEM private key with a full base64 body and matching END', () => {
    const text =
      'const key = `\n-----BEGIN RSA PRIVATE KEY-----\n' +
      'MIIEowIBAAKCAQEAtx9L8+ClAeGtQeZzYh0aFAYhU8pQ2K0KJhZk1XvT0mF8+lZ9\n' +
      'Rz3Wc2m0S1oQwq7bYhX9pS3nJvKdE7yA0FqW3z8Rk1cVnQpB2xTmY4sN6oL5eD8g\n' +
      '-----END RSA PRIVATE KEY-----\n`;';
    expect(scanTextForCredentialMarkers(text)).toMatch(/PEM/);
  });

  // A BEGIN for one key type paired with an END for a DIFFERENT key type must not satisfy the
  // structural check — the label has to match, the same way a real single PEM block always does.
  it('does not flag a BEGIN of one type paired with an END of a different type', () => {
    const text =
      '-----BEGIN CERTIFICATE-----\nMIIEowIBAAKCAQEAtx9L8+ClAeGtQeZzYh0aFAYhU8pQ2K0KJhZk1XvT0mF8+lZ9\n-----END RSA PRIVATE KEY-----\n';
    expect(scanTextForCredentialMarkers(text)).toBeNull();
  });
});

describe('scanTextForCredentialMarkers — RUN-283, the JSON-header discriminator', () => {
  // The four false positives this task measured directly, one per language, each a chained
  // member/namespace access with segments well past the 10-char floor — the exact shape a length
  // floor alone can never separate from a real token's header/payload/signature segments.
  it.each([
    ['Unreal Build Tool (UBT), longer arm', 'PCHUsage = ModuleRules.PCHUsageMode.UseExplicitOrSharedPCHs;'],
    ['Unreal Build Tool (UBT), shorter arm', 'PCHUsage = ModuleRules.PCHUsageMode.UseExplicitPCHs;'],
    [
      'plain TypeScript chained member access',
      'const x = SomeNamespace.SomeLongClassName.SomeLongMemberName;',
    ],
    ['plain Python dotted attribute access', 'value = module_alias.SubModuleName.CONSTANT_NAME_HERE'],
  ])('does not flag ordinary code shaped like a JWT: %s', (_label, text) => {
    expect(scanTextForCredentialMarkers(text)).toBeNull();
  });

  // Hazard A: a single `.test()` (or a loop that returns on the first candidate) would leak here —
  // the FIRST dotted-triple in this text is the false-positive UBT line, and a naive "find one
  // candidate, validate it, stop" scan would report null without ever reaching the real token below
  // it. Every candidate must be checked; withhold if ANY of them validates.
  it('still withholds when a real JWT appears AFTER a false-positive dotted-triple in the same file', () => {
    const text = [
      'PCHUsage = ModuleRules.PCHUsageMode.UseExplicitOrSharedPCHs;',
      'const x = SomeNamespace.SomeLongClassName.SomeLongMemberName;',
      'const leaked = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.' +
        'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";',
    ].join('\n');
    expect(scanTextForCredentialMarkers(text)).toMatch(/JWT/);
  });

  // Hazard B: `JWT_CANDIDATE_RE` must anchor at both ends, or a match can slice a candidate out of
  // the middle of a longer identifier run rather than the real segment boundaries. Both flush
  // against quotes and surrounded by whitespace must still find the whole token.
  it('finds a real JWT flush against quotes with no surrounding whitespace', () => {
    const text =
      '"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"';
    expect(scanTextForCredentialMarkers(text)).toMatch(/JWT/);
  });

  it('finds a real JWT surrounded by plain whitespace', () => {
    const text =
      'token is   eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c   end of line';
    expect(scanTextForCredentialMarkers(text)).toMatch(/JWT/);
  });

  // A genuine second real-world JWT shape (a different `alg`, a `kid` header field, minimal claim
  // payload) — locked decision 2: every real JWT shape the fixtures already cover must still be
  // caught, proven with more than one token shape rather than only the one repeated fixture.
  it('flags a distinct genuine JWT shape (RS256, kid header, minimal claims) anywhere in a file', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'abc123' })).toString(
      'base64url',
    );
    const payload = Buffer.from(JSON.stringify({ sub: '1', iat: 1700000000 })).toString('base64url');
    const text = `Authorization: Bearer ${header}.${payload}.k3y9Zq2Wv7Nc5Fh0SaP2mK9Rt6Yh1Bv3`;
    expect(scanTextForCredentialMarkers(text)).toMatch(/JWT/);
  });

  // The reason `decodesToJsonObject` stops at "a JSON object" instead of also demanding JOSE's
  // mandatory `alg`: `itsdangerous` (Flask/Django signed session cookies) is the same three-segment
  // shape with a headerless JSON payload first and no `alg` anywhere in it. It is a real credential,
  // and the stricter JOSE test — measured against all three corpora at zero false-positive
  // difference — would have let it through. This test is what stops a future edit "completing" the
  // check back toward RFC 7515 and silently reopening that class.
  it('flags a signed token whose JSON first segment carries no `alg` (itsdangerous session cookie)', () => {
    const payload = Buffer.from(JSON.stringify({ user_id: 42, csrf: 'abc' })).toString('base64url');
    const text = `SESSION_COOKIE = "${payload}.aBcDeFgHiJ.7xQ1kL_pZm9RtYuIoPaSdFgHjKl"`;
    expect(scanTextForCredentialMarkers(text)).toMatch(/JWT/);
  });
});
