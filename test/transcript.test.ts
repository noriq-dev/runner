// RUN-74: the transcript emitter — the runner half of "why was the run refused".
import { describe, expect, it } from 'vitest';
import { type RunLogSegment, RunTranscript } from '../src/transcript';

function collect() {
  const out: RunLogSegment[] = [];
  return { out, t: new RunTranscript((s) => out.push(...s)) };
}

describe('RunTranscript', () => {
  it('coalesces same-voice text and flushes on a voice switch — the stream reads as turns', () => {
    const { out, t } = collect();
    t.text('agent', 'working ');
    t.text('agent', 'on it…');
    t.text('reviewer', 'VERDICT: FAIL', 1); // voice switch → the agent buffer flushes first
    t.flush();
    expect(out.map((s) => [s.role, s.round, s.text])).toEqual([
      ['agent', null, 'working on it…'],
      ['reviewer', 1, 'VERDICT: FAIL'],
    ]);
  });

  it('a milestone flushes the speaking voice FIRST, so the human-read ordering is real', () => {
    const { out, t } = collect();
    t.text('agent', 'done, I think');
    t.milestone('verify command passed (`npm test`)');
    expect(out.map((s) => s.role)).toEqual(['agent', 'system']);
  });

  it('seqs are monotonic across flushes — the server dedups on them', () => {
    const { out, t } = collect();
    t.text('agent', 'a');
    t.milestone('m1');
    t.text('reviewer', 'r', 1);
    t.end();
    expect(out.map((s) => s.seq)).toEqual([0, 1, 2]);
  });

  it('splits an oversized buffer into several segments, never a frame the schema rejects', () => {
    const { out, t } = collect();
    t.text('agent', 'x'.repeat(20_000));
    t.flush();
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...out.map((s) => s.text.length))).toBeLessThanOrEqual(8000);
    expect(out.map((s) => s.text).join('')).toBe('x'.repeat(20_000));
  });

  it('a sink that throws is swallowed — a transcript must never gate a run', () => {
    const t = new RunTranscript(() => {
      throw new Error('socket gone');
    });
    t.text('agent', 'hello');
    expect(() => t.milestone('still fine')).not.toThrow();
  });

  it('reviewer rounds are distinct voices — round 1 and round 2 never coalesce', () => {
    const { out, t } = collect();
    t.text('reviewer', 'first look', 1);
    t.text('reviewer', 'second look', 2);
    t.flush();
    expect(out.map((s) => [s.round, s.text])).toEqual([
      [1, 'first look'],
      [2, 'second look'],
    ]);
  });
});
