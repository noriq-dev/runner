// The prompt template rail: prompts/*.md maintained as files, rendered by a deliberately
// tiny mustache subset. Byte-compatibility of each real prompt is asserted by the tests of
// its assembler (supervisor, verify, verify-agent, verify-reviewer, land, parked) — this
// file covers the rail itself.
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { promptTemplate, renderPrompt, renderTemplate, renderUserTemplate } from '../src/prompts';

describe('renderTemplate', () => {
  it('interpolates variables; null renders as nothing', () => {
    expect(renderTemplate('run {{cmd}} now{{note}}', { cmd: 'npm test', note: null })).toBe(
      'run npm test now',
    );
  });

  it('keeps a # section only when truthy, an ^ section only when falsy', () => {
    const t = '{{#cmd}}with {{cmd}}{{/cmd}}{{^cmd}}bare{{/cmd}}';
    expect(renderTemplate(t, { cmd: 'git diff' })).toBe('with git diff');
    expect(renderTemplate(t, { cmd: null })).toBe('bare');
    expect(renderTemplate(t, { cmd: '' })).toBe('bare'); // '' must not switch a sentence on
    expect(renderTemplate(t, { cmd: false })).toBe('bare');
  });

  it('is literal text substitution — no whitespace magic around section tags', () => {
    expect(renderTemplate('a{{#x}}\nb{{/x}}\nc', { x: true })).toBe('a\nb\nc');
    expect(renderTemplate('a{{#x}}\nb{{/x}}\nc', { x: false })).toBe('a\nc');
  });

  it('a missing variable throws — a hole in a prompt is a programming error, not a render', () => {
    expect(() => renderTemplate('hi {{who}}', {})).toThrow(/\{\{who\}\}/);
    expect(() => renderTemplate('{{#who}}x{{/who}}', {})).toThrow(/\{\{#who\}\}/);
  });
});

describe('renderUserTemplate', () => {
  it('renders an unknown interpolation empty and warns once with variable + source', () => {
    const warnings: Array<{ message: string; variable: string; source: string }> = [];
    const rendered = renderUserTemplate(
      '{{typo}}/{{typo}}',
      {},
      {
        source: '/repo/.noriq/workflows/docs.md',
        warn: (message, details) => warnings.push({ message, ...details }),
      },
    );
    expect(rendered).toBe('/');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      variable: 'typo',
      source: '/repo/.noriq/workflows/docs.md',
    });
    expect(warnings[0]?.message).toContain('{{typo}}');
    expect(warnings[0]?.message).toContain('/repo/.noriq/workflows/docs.md');
  });

  it('treats an unknown section as falsy without duplicating its warning', () => {
    const warnings: string[] = [];
    const rendered = renderUserTemplate(
      '{{#missing}}wrong{{/missing}}{{^missing}}fallback {{missing}}{{/missing}}',
      {},
      { source: 'workflow.toml', warn: (message) => warnings.push(message) },
    );
    expect(rendered).toBe('fallback ');
    expect(warnings).toHaveLength(1);
  });

  it('does not make strict built-in rendering lenient', () => {
    expect(() => renderTemplate('{{missing}}', {})).toThrow(/missing/);
  });
});

describe('prompt templates on disk', () => {
  it('every prompts/*.md loads, and every {{tag}} in it is well-formed', () => {
    const names = readdirSync(new URL('../prompts/', import.meta.url))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3));
    expect(names.length).toBeGreaterThanOrEqual(9);
    for (const name of names) {
      const t = promptTemplate(name);
      expect(t.length).toBeGreaterThan(0);
      expect(t).not.toMatch(/\s$/); // trailing newline stripped: prompts end on their last word
      // Sections must pair up: strip well-formed sections, then no {{#…}}/{{^…}}/{{/…}} may remain.
      const rest = t.replace(/\{\{([#^])(\w+)\}\}[\s\S]*?\{\{\/\2\}\}/g, '');
      expect(rest, `unbalanced section in prompts/${name}.md`).not.toMatch(/\{\{[#^/]/);
    }
  });

  it('unknown template name throws with the name in the message', () => {
    expect(() => renderPrompt('no-such-prompt', {})).toThrow(/no-such-prompt/);
  });
});
