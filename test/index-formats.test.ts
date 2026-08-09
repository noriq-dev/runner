import { describe, expect, it } from 'vitest';
import {
  createJsonAdapter,
  createMarkdownAdapter,
  createTomlAdapter,
  githubHeadingSlug,
  isRepoGuidanceSurfacePath,
} from '../src/index-formats';

const jsonAdapter = createJsonAdapter();
const tomlAdapter = createTomlAdapter();
const markdownAdapter = createMarkdownAdapter();

describe('canParse / languages', () => {
  it('claims the extension each adapter owns, and declares its language', () => {
    expect(jsonAdapter.canParse('package.json')).toBe(true);
    expect(jsonAdapter.canParse('a.toml')).toBe(false);
    expect(jsonAdapter.languages).toEqual(['json']);

    expect(tomlAdapter.canParse('.noriq/project.toml')).toBe(true);
    expect(tomlAdapter.canParse('a.json')).toBe(false);
    expect(tomlAdapter.languages).toEqual(['toml']);

    expect(markdownAdapter.canParse('README.md')).toBe(true);
    expect(markdownAdapter.canParse('a.markdown')).toBe(true);
    expect(markdownAdapter.canParse('a.txt')).toBe(false);
    expect(markdownAdapter.languages).toEqual(['markdown']);
  });
});

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

describe('JSON adapter', () => {
  it('extracts top-level primitive keys as leaf symbols', async () => {
    const result = await jsonAdapter.parse({
      path: 'package.json',
      content: '{"name": "runner", "version": "1.0.0"}',
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ symbolPath: ['name'], nodeType: 'symbol', label: 'name', content: 'runner' }),
    );
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ symbolPath: ['version'], content: '1.0.0' }),
    );
  });

  it('nests object keys as sections with no content of their own', async () => {
    const result = await jsonAdapter.parse({
      path: 'package.json',
      content: '{"scripts": {"test": "vitest run", "build": "esbuild"}}',
    });
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ symbolPath: ['scripts'], nodeType: 'symbol', content: null }),
    );
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ symbolPath: ['scripts', 'test'], content: 'vitest run' }),
    );
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ symbolPath: ['scripts', 'build'], content: 'esbuild' }),
    );
  });

  it('withholds a value under a sensitive key, keeping the key entity', async () => {
    const result = await jsonAdapter.parse({
      path: 'config.json',
      content: '{"password": "hunter2"}',
    });
    const sym = result.symbols.find((s) => s.symbolPath.join('.') === 'password');
    expect(sym).toEqual(expect.objectContaining({ label: 'password', content: null }));
  });

  it('withholds a shaped value even under an innocuous key', async () => {
    const result = await jsonAdapter.parse({
      path: 'config.json',
      content: '{"a": "ghp_16C7e42F292c6912E7710c838347Ae178B4a"}',
    });
    const sym = result.symbols.find((s) => s.symbolPath.join('.') === 'a');
    expect(sym?.content).toBeNull();
  });

  it('descends into an array of objects, index-suffixed', async () => {
    const result = await jsonAdapter.parse({
      path: 'a.json',
      content: '{"workspaces": [{"name": "pkg-a"}, {"name": "pkg-b"}]}',
    });
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ symbolPath: ['workspaces[0]', 'name'], content: 'pkg-a' }),
    );
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ symbolPath: ['workspaces[1]', 'name'], content: 'pkg-b' }),
    );
  });

  it('summarises an array of primitives as one bounded entity, withheld all-or-nothing', async () => {
    const result = await jsonAdapter.parse({
      path: 'a.json',
      content: '{"keywords": ["cli", "daemon", "runner"]}',
    });
    const sym = result.symbols.find((s) => s.symbolPath.join('.') === 'keywords');
    expect(sym?.content).toBe('[cli, daemon, runner]');
  });

  it('withholds an entire primitive array if any element looks secret-shaped', async () => {
    const result = await jsonAdapter.parse({
      path: 'a.json',
      content: '{"tokens": ["ok", "ghp_16C7e42F292c6912E7710c838347Ae178B4a"]}',
    });
    const sym = result.symbols.find((s) => s.symbolPath.join('.') === 'tokens');
    expect(sym?.content).toBeNull();
  });

  it('never throws on malformed JSON — returns a diagnostic and no symbols', async () => {
    const result = await jsonAdapter.parse({ path: 'a.json', content: '{"a": SECRET_LOOKING_GARBAGE,}' });
    expect(result.symbols).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.severity).toBe('error');
  });

  it('never leaks raw source content into the parse-failure diagnostic', async () => {
    const result = await jsonAdapter.parse({
      path: 'a.json',
      content: '{"password": "sk-VERY_SECRET_LOOKING_VALUE_HERE_12345 garbage',
    });
    for (const d of result.diagnostics) {
      expect(d.message).not.toMatch(/VERY_SECRET/);
      expect(d.message).not.toMatch(/sk-/);
    }
  });

  it('bounds recursion depth, emitting a diagnostic rather than throwing or hanging', async () => {
    let content = '{"a":';
    for (let i = 0; i < 12; i++) content += '{"a":';
    content += '"leaf"';
    for (let i = 0; i < 13; i++) content += '}';
    const result = await jsonAdapter.parse({ path: 'a.json', content });
    expect(result.diagnostics.some((d) => /deeper than/.test(d.message))).toBe(true);
  });

  it('bounds the per-file entity count', async () => {
    const entries = Array.from({ length: 600 }, (_, i) => `"k${i}": ${i}`).join(',');
    const result = await jsonAdapter.parse({ path: 'a.json', content: `{${entries}}` });
    expect(result.symbols.length).toBeLessThanOrEqual(500);
    expect(result.diagnostics.some((d) => /more than 500 entities/.test(d.message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TOML
// ---------------------------------------------------------------------------

describe('TOML adapter', () => {
  it('extracts project.toml structure as nested entities', async () => {
    const content = `
key = "myproj"

[verify]
cmd = "npm run check"

[land]
branch = "main"
autoPush = true
`;
    const result = await tomlAdapter.parse({ path: '.noriq/project.toml', content });
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ symbolPath: ['key'], content: 'myproj' }),
    );
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ symbolPath: ['verify', 'cmd'], content: 'npm run check' }),
    );
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ symbolPath: ['land', 'branch'], content: 'main' }),
    );
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ symbolPath: ['land', 'autoPush'], content: 'true' }),
    );
  });

  it('withholds a value under a sensitive key without exposing it, keeping the key entity', async () => {
    const content = `
[auth]
token = "ghp_16C7e42F292c6912E7710c838347Ae178B4a"
`;
    const result = await tomlAdapter.parse({ path: '.noriq/project.toml', content });
    const sym = result.symbols.find((s) => s.symbolPath.join('.') === 'auth.token');
    expect(sym).toEqual(expect.objectContaining({ content: null }));
    // the SECTION key itself is still a real, searchable entity — only the leaf value withholds.
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['auth'], content: null }));
  });

  it('never throws on malformed TOML — returns a bounded diagnostic with position, no raw content', async () => {
    const content = 'secret_key = "sk-abcdefghijklmnop"\nbroken =';
    const result = await tomlAdapter.parse({ path: '.noriq/project.toml', content });
    expect(result.symbols).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.severity).toBe('error');
    expect(result.diagnostics[0]!.message).toMatch(/line \d+, column \d+/);
    expect(result.diagnostics[0]!.message).not.toMatch(/secret_key/);
    expect(result.diagnostics[0]!.message).not.toMatch(/sk-/);
  });

  it('descends into an array of tables', async () => {
    const content = `
[[servers]]
name = "alpha"

[[servers]]
name = "beta"
`;
    const result = await tomlAdapter.parse({ path: 'a.toml', content });
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ symbolPath: ['servers[0]', 'name'], content: 'alpha' }),
    );
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ symbolPath: ['servers[1]', 'name'], content: 'beta' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

describe('Markdown adapter — headings', () => {
  it('extracts a flat set of top-level headings with deterministic ranges', async () => {
    const content = '# Title\n\nintro text\n\n## Section One\n\nbody one\n\n## Section Two\n\nbody two\n';
    const result = await markdownAdapter.parse({ path: 'README.md', content });
    const title = result.symbols.find((s) => s.symbolPath.join('.') === 'Title');
    expect(title).toBeTruthy();
    // '# Title' (1) / '' (2) / 'intro text' (3) / '' (4) / '## Section One' (5) / '' (6) /
    // 'body one' (7) / '' (8) / '## Section Two' (9) / '' (10) / 'body two' (11) / '' (12, the
    // trailing-newline artifact) — Title (level 1) closes only at EOF, since both Section
    // headings are level 2 (deeper, not "same or shallower").
    expect(title!.range).toEqual({ startLine: 1, endLine: 12 });

    const one = result.symbols.find((s) => s.symbolPath.join('.') === 'Title.Section One');
    expect(one!.range).toEqual({ startLine: 5, endLine: 8 });

    const two = result.symbols.find((s) => s.symbolPath.join('.') === 'Title.Section Two');
    expect(two!.range).toEqual({ startLine: 9, endLine: 12 });
  });

  it('nests heading hierarchy outer-to-inner by trimmed heading text', async () => {
    const content = '# A\n## B\n### C\ntext\n## D\n';
    const result = await markdownAdapter.parse({ path: 'a.md', content });
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['A'] }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['A', 'B'] }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['A', 'B', 'C'] }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['A', 'D'] }));
  });

  it('a heading following a shallower one closes the deeper section correctly', async () => {
    const content = '# A\n## B\ntext under B\n# E\ntext under E\n';
    const result = await markdownAdapter.parse({ path: 'a.md', content });
    const a = result.symbols.find((s) => s.symbolPath.join('.') === 'A')!;
    expect(a.range).toEqual({ startLine: 1, endLine: 3 });
    const e = result.symbols.find((s) => s.symbolPath.join('.') === 'E')!;
    // Lines: '# A'(1) '## B'(2) 'text under B'(3) '# E'(4) 'text under E'(5) ''(6, trailing
    // newline artifact) — E is the last heading, so it closes at EOF (6), not at line 5.
    expect(e.range).toEqual({ startLine: 4, endLine: 6 });
  });

  it('declines a heading with no text after the hashes', async () => {
    const result = await markdownAdapter.parse({ path: 'a.md', content: '#\n## \nreal text\n' });
    expect(result.symbols.filter((s) => s.nodeType === 'symbol' && s.range?.startLine === 1)).toEqual([]);
  });

  it('strips a trailing ATX closing sequence', async () => {
    const result = await markdownAdapter.parse({ path: 'a.md', content: '# Title #####\n' });
    expect(result.symbols).toContainEqual(expect.objectContaining({ label: 'Title' }));
  });

  it('does not recognise an indented "heading" (declined by omission)', async () => {
    const result = await markdownAdapter.parse({ path: 'a.md', content: '  # Not a heading\n' });
    expect(result.symbols).toEqual([]);
  });

  it('withholds section content that contains a secret-shaped value, keeping the heading entity', async () => {
    const content = '# Setup\n\nexport TOKEN=ghp_16C7e42F292c6912E7710c838347Ae178B4a\n';
    const result = await markdownAdapter.parse({ path: 'a.md', content });
    const sym = result.symbols.find((s) => s.symbolPath.join('.') === 'Setup');
    expect(sym).toEqual(expect.objectContaining({ label: 'Setup', content: null }));
  });
});

describe('Markdown adapter — fenced code blocks', () => {
  it('extracts a fenced code block with a declared language, nested under its heading', async () => {
    const content = '# Usage\n\n```bash\nnpm run check\n```\n';
    const result = await markdownAdapter.parse({ path: 'a.md', content });
    const block = result.symbols.find((s) => s.label.startsWith('code block'));
    expect(block).toEqual(
      expect.objectContaining({
        symbolPath: ['Usage', 'code-block-1'],
        label: 'code block (bash)',
        content: 'npm run check',
        range: { startLine: 3, endLine: 5 },
      }),
    );
  });

  it('declines a fenced code block with no declared language', async () => {
    const content = '```\nno language here\n```\n';
    const result = await markdownAdapter.parse({ path: 'a.md', content });
    expect(result.symbols.filter((s) => s.label.startsWith('code block'))).toEqual([]);
  });

  it('runs an unterminated fence to EOF rather than dropping it', async () => {
    // Lines: '```ts'(1) 'const a = 1;'(2) 'const b = 2;'(3) ''(4, trailing-newline artifact) —
    // no closing fence, so the block runs through the last line, including that artifact.
    const content = '```ts\nconst a = 1;\nconst b = 2;\n';
    const result = await markdownAdapter.parse({ path: 'a.md', content });
    const block = result.symbols.find((s) => s.label.startsWith('code block'));
    expect(block?.content).toBe('const a = 1;\nconst b = 2;\n');
    expect(block?.range).toEqual({ startLine: 1, endLine: 4 });
  });

  it('withholds a code block whose body contains a secret-shaped value', async () => {
    const content = '```bash\nexport TOKEN=ghp_16C7e42F292c6912E7710c838347Ae178B4a\n```\n';
    const result = await markdownAdapter.parse({ path: 'a.md', content });
    const block = result.symbols.find((s) => s.label.startsWith('code block'));
    expect(block?.content).toBeNull();
  });
});

describe('Markdown adapter — links and code references', () => {
  // These are `symbol` entities, never `ParsedImport` — see `parseMarkdown`'s own doc comment for
  // why: `indexer.ts` now resolves a `.`-leading `ParsedImport.specifier` into a wire `imports`
  // edge, which means "module dependency" on the wire, and a doc link/mention is not that.
  it('does not use the imports channel at all', async () => {
    const result = await markdownAdapter.parse({
      path: 'a.md',
      content: 'See [the docs](https://example.com/docs) and `src/index-formats.ts`.\n',
    });
    expect(result.imports ?? []).toEqual([]);
  });

  it('records an external link as a symbol entity, structurally labelled, target in content', async () => {
    const result = await markdownAdapter.parse({
      path: 'a.md',
      content: 'See [the docs](https://example.com/docs) for more.\n',
    });
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ label: 'link', content: 'https://example.com/docs', nodeType: 'symbol' }),
    );
  });

  it('records a relative file link as a symbol entity', async () => {
    const result = await markdownAdapter.parse({
      path: 'a.md',
      content: 'See [CLAUDE.md](../CLAUDE.md) for the design.\n',
    });
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ label: 'link', content: '../CLAUDE.md' }),
    );
  });

  it('nests a reference entity under its enclosing heading, identified by its TARGET (not a position)', async () => {
    const content = '# Setup\n\nSee [the docs](https://example.com/docs) for more.\n';
    const result = await markdownAdapter.parse({ path: 'a.md', content });
    const ref = result.symbols.find((s) => s.label === 'link');
    expect(ref?.symbolPath).toEqual(['Setup', 'https://example.com/docs']);
  });

  it('identity is stable across an unrelated insertion above it — the whole point of target-based identity', async () => {
    const before = '# Setup\n\nSee [the docs](https://example.com/docs) for more.\n';
    const after =
      '# Setup\n\n[an unrelated new link](https://example.com/new)\n\nSee [the docs](https://example.com/docs) for more.\n';
    const beforeRef = (await markdownAdapter.parse({ path: 'a.md', content: before })).symbols.find(
      (s) => s.label === 'link' && s.content === 'https://example.com/docs',
    );
    const afterRef = (await markdownAdapter.parse({ path: 'a.md', content: after })).symbols.find(
      (s) => s.label === 'link' && s.content === 'https://example.com/docs',
    );
    expect(afterRef?.symbolPath).toEqual(beforeRef?.symbolPath);
  });

  it('two references to the same target under one heading collide, left to dedupeSymbolPaths', async () => {
    const content = '# Setup\n\n[a](https://example.com/x) and [b](https://example.com/x) again.\n';
    const result = await markdownAdapter.parse({ path: 'a.md', content });
    const matching = result.symbols.filter(
      (s) => s.label === 'link' && s.symbolPath[0] === 'Setup' && s.symbolPath[1] === 'https://example.com/x',
    );
    // Both are emitted with the SAME raw symbolPath — collision resolution is index-entity.ts's
    // dedupeSymbolPaths' job, not this adapter's (see referenceSymbol's own doc).
    expect(matching).toHaveLength(2);
  });

  it('drops an in-document anchor link that matches one of its own headings', async () => {
    const content = '# Setup\n\nSee [setup](#setup) above.\n\n## Details\n';
    const result = await markdownAdapter.parse({ path: 'a.md', content });
    expect(result.symbols.filter((s) => s.label === 'link')).toEqual([]);
  });

  it('keeps an anchor link that does not match any heading in this document', async () => {
    const content = '# Setup\n\nSee [elsewhere](#not-a-real-heading) above.\n';
    const result = await markdownAdapter.parse({ path: 'a.md', content });
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ label: 'link', content: '#not-a-real-heading' }),
    );
  });

  it('records an inline code span that looks like a file path as a code-reference symbol entity', async () => {
    const result = await markdownAdapter.parse({
      path: 'a.md',
      content: 'See `src/index-formats.ts` for the adapter.\n',
    });
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ label: 'code reference', content: 'src/index-formats.ts' }),
    );
  });

  it('declines an inline code span that is not path-shaped', async () => {
    const result = await markdownAdapter.parse({
      path: 'a.md',
      content: 'Set the flag to `true` or `--verbose`.\n',
    });
    expect(result.symbols.filter((s) => s.label === 'code reference')).toEqual([]);
  });

  it('declines the entity outright when the target looks secret-shaped — never nulled content', async () => {
    // A reference's target IS its identity here (symbolPath), and a URI cannot be withheld once
    // minted — so unlike a config leaf (key survives, value nulls), a secret-shaped target means
    // no entity at all. See referenceSymbol's own doc for the full reasoning.
    const result = await markdownAdapter.parse({
      path: 'a.md',
      content: 'See [token](https://example.com?token=ghp_16C7e42F292c6912E7710c838347Ae178B4a) for more.\n',
    });
    expect(result.symbols.filter((s) => s.label === 'link')).toEqual([]);
  });

  it('declines a code-reference entity outright when the target looks secret-shaped', async () => {
    // Path-shaped (matches PATH_LIKE_RE — extension, no whitespace) AND secret-shaped (the `sk-`
    // issuer prefix), so it is a real code reference candidate that must still be declined whole.
    const result = await markdownAdapter.parse({
      path: 'a.md',
      content: 'See `sk-abcdefghijklmnopqrstuvwxyz0123456789.txt` for the key.\n',
    });
    expect(result.symbols.filter((s) => s.label === 'code reference')).toEqual([]);
  });
});

describe('githubHeadingSlug', () => {
  it('lowercases, strips punctuation, and hyphenates spaces — deterministically', () => {
    expect(githubHeadingSlug('Getting Started!')).toBe('getting-started');
    expect(githubHeadingSlug('Getting Started!')).toBe(githubHeadingSlug('Getting Started!'));
  });

  it('matches the common GitHub convention for a heading with a code span', () => {
    expect(githubHeadingSlug('The `index.ts` file')).toBe('the-indexts-file');
  });
});

describe('isRepoGuidanceSurfacePath', () => {
  it.each([
    'CLAUDE.md',
    'AGENTS.md',
    'README.md',
    'CONTRIBUTING.md',
    'packages/api/README.md',
    '.noriq/notes.md',
  ])('recognises %s', (path) => {
    expect(isRepoGuidanceSurfacePath(path)).toBe(true);
  });

  it('recognises anything under docs/ at any depth', () => {
    expect(isRepoGuidanceSurfacePath('docs/architecture.md')).toBe(true);
    expect(isRepoGuidanceSurfacePath('packages/api/docs/setup.md')).toBe(true);
  });

  it('does not recognise an arbitrary markdown file elsewhere in the repo', () => {
    expect(isRepoGuidanceSurfacePath('src/notes.md')).toBe(false);
    expect(isRepoGuidanceSurfacePath('CHANGELOG.md')).toBe(false);
  });

  it('does not recognise a nested .noriq markdown file (only directly under it)', () => {
    expect(isRepoGuidanceSurfacePath('.noriq/workflows/notes.md')).toBe(false);
  });

  it('extraction is uniform regardless of guidance status — headings still extract from a non-guidance file', async () => {
    const result = await markdownAdapter.parse({ path: 'src/notes.md', content: '# Notes\n\nsome text\n' });
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['Notes'] }));
  });
});
