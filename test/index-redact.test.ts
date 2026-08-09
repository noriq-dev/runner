import { describe, expect, it } from 'vitest';
import {
  keyLooksSensitive,
  looksHighEntropy,
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
