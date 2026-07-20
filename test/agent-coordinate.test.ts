import { describe, expect, it } from 'vitest';
import {
  type AgentCoordinate,
  coordinateFromParts,
  formatCoordinate,
  mergeCoordinate,
  parseCoordinate,
  tryParseCoordinate,
} from '../src/agent-coordinate';

describe('parseCoordinate', () => {
  it('parses a full coordinate, restoring dotted model versions', () => {
    expect(parseCoordinate('claude.opus-4_8.high')).toEqual({
      tool: 'claude',
      model: 'opus-4.8',
      effort: 'high',
    });
  });

  it('handles multi-dash models (gpt-5_6-sol → gpt-5.6-sol)', () => {
    expect(parseCoordinate('codex.gpt-5_6-sol.high')).toEqual({
      tool: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
  });

  it('accepts partial coordinates — model then effort fall through', () => {
    expect(parseCoordinate('claude')).toEqual({ tool: 'claude', model: null, effort: null });
    expect(parseCoordinate('claude.opus-4_8')).toEqual({
      tool: 'claude',
      model: 'opus-4.8',
      effort: null,
    });
  });

  it('reads an empty MIDDLE segment as "default model, explicit effort"', () => {
    expect(parseCoordinate('claude..high')).toEqual({ tool: 'claude', model: null, effort: 'high' });
  });

  it('trims surrounding whitespace', () => {
    expect(parseCoordinate('  codex.gpt-5_6-sol  ')).toEqual({
      tool: 'codex',
      model: 'gpt-5.6-sol',
      effort: null,
    });
  });

  it('throws on an empty coordinate or an empty tool', () => {
    expect(() => parseCoordinate('')).toThrow(/empty/);
    expect(() => parseCoordinate('.opus-4_8.high')).toThrow(/no tool/);
  });

  it('throws on too many segments', () => {
    expect(() => parseCoordinate('claude.opus.4.8.high')).toThrow(/segments/);
  });

  it('throws on an effort outside RunEffort', () => {
    expect(() => parseCoordinate('claude.opus-4_8.turbo')).toThrow(/effort/);
  });

  it('accepts every RunEffort value', () => {
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(parseCoordinate(`claude.m.${e}`).effort).toBe(e);
    }
  });
});

describe('tryParseCoordinate', () => {
  it('returns null instead of throwing on malformed input', () => {
    expect(tryParseCoordinate('claude.opus-4_8.turbo')).toBeNull();
    expect(tryParseCoordinate('')).toBeNull();
    expect(tryParseCoordinate('claude.opus-4_8.high')).not.toBeNull();
  });
});

describe('formatCoordinate ⟷ parseCoordinate round-trip', () => {
  const cases: AgentCoordinate[] = [
    { tool: 'claude', model: 'opus-4.8', effort: 'high' },
    { tool: 'codex', model: 'gpt-5.6-sol', effort: 'max' },
    { tool: 'claude', model: 'opus-4.8', effort: null },
    { tool: 'claude', model: null, effort: 'high' },
    { tool: 'claude', model: null, effort: null },
  ];
  for (const c of cases) {
    it(`round-trips ${JSON.stringify(c)}`, () => {
      expect(parseCoordinate(formatCoordinate(c))).toEqual(c);
    });
  }

  it('drops trailing unset segments but keeps the empty middle', () => {
    expect(formatCoordinate({ tool: 'claude', model: 'opus-4.8', effort: null })).toBe('claude.opus-4_8');
    expect(formatCoordinate({ tool: 'claude', model: null, effort: null })).toBe('claude');
    expect(formatCoordinate({ tool: 'claude', model: null, effort: 'high' })).toBe('claude..high');
  });
});

describe('coordinateFromParts (legacy triple → coordinate)', () => {
  it('packages the wire triple, mapping absent fields to null', () => {
    expect(coordinateFromParts('codex', null, null)).toEqual({ tool: 'codex', model: null, effort: null });
    expect(coordinateFromParts('claude', 'claude-opus-4-8', 'xhigh')).toEqual({
      tool: 'claude',
      model: 'claude-opus-4-8',
      effort: 'xhigh',
    });
  });
});

describe('legacy triple ⟷ coordinate equivalence (RUN-124 deprecation window)', () => {
  // The back-compat contract: for one deprecation window the runner accepts BOTH a coordinate and
  // the legacy {tool, model, effort} triple, and they must resolve to the SAME parts. This pins it.
  const triples: Array<[string, string | null, string | null]> = [
    ['claude', 'claude-opus-4-8', 'high'],
    ['codex', 'gpt-5.6-sol', null],
    ['claude', null, 'max'],
    ['codex', null, null],
  ];
  for (const [tool, model, effort] of triples) {
    it(`triple (${tool}, ${model}, ${effort}) → coordinate → identical triple`, () => {
      const coord = coordinateFromParts(tool, model, effort as never);
      // format then re-parse: the coordinate is a lossless carrier of the triple
      const round = parseCoordinate(formatCoordinate(coord));
      expect({ tool: round.tool, model: round.model, effort: round.effort }).toEqual({
        tool,
        model,
        effort,
      });
    });
  }
});

describe('mergeCoordinate (dispatch → repo defaults → driver default)', () => {
  it('fills only the fields the primary leaves null, first fallback wins', () => {
    const primary: AgentCoordinate = { tool: 'claude', model: null, effort: 'high' };
    const repoDefaults = { model: 'opus-4.8', effort: 'low' as const };
    expect(mergeCoordinate(primary, repoDefaults)).toEqual({
      tool: 'claude',
      model: 'opus-4.8', // filled from repo defaults
      effort: 'high', // primary's own value survives
    });
  });

  it('walks multiple fallbacks in order until a field is pinned', () => {
    const primary: AgentCoordinate = { tool: 'codex', model: null, effort: null };
    expect(mergeCoordinate(primary, { effort: 'medium' }, { model: 'gpt-5.6', effort: 'max' })).toEqual({
      tool: 'codex',
      model: 'gpt-5.6',
      effort: 'medium', // the earlier fallback pinned it first
    });
  });

  it('ignores null/undefined fallbacks', () => {
    const primary: AgentCoordinate = { tool: 'claude', model: 'm', effort: 'high' };
    expect(mergeCoordinate(primary, null, undefined)).toEqual(primary);
  });
});
