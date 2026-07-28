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

// A CONTINUED run is a second sitting under the SAME run id, and the server stores segments under
// PRIMARY KEY (run_id, seq) written with INSERT OR IGNORE — the dedupe that makes redelivery after
// a reconnect harmless. A sitting that numbers from zero therefore collides with everything the
// last one wrote and is discarded without a word (RUN-183). Measured live: 49 minutes of work,
// zero recorded segments, and no way for a human to tell working from stalled.
describe('a continuation resumes the numbering (RUN-183)', () => {
  it('numbers above the previous sitting instead of colliding with it', () => {
    const first: RunLogSegment[] = [];
    const a = new RunTranscript((s) => first.push(...s));
    a.text('agent', 'sitting one');
    a.flush();
    a.milestone('run finished: failed');
    const resumeFrom = a.nextSeq();

    const second: RunLogSegment[] = [];
    const b = new RunTranscript((s) => second.push(...s));
    b.seedFrom(resumeFrom);
    b.text('agent', 'sitting two');
    b.flush();

    // Not one seq in common — every segment of the second sitting is a row the server will accept.
    const used = new Set(first.map((s) => s.seq));
    expect(second.every((s) => !used.has(s.seq))).toBe(true);
    expect(second[0]!.seq).toBe(resumeFrom);
  });

  it('refuses to reseed once it has already spoken', () => {
    // A transcript with a reader following it must not have its numbering moved underneath them.
    const out: RunLogSegment[] = [];
    const t = new RunTranscript((s) => out.push(...s));
    t.text('agent', 'already talking');
    t.flush();
    t.seedFrom(500);
    t.text('agent', 'next');
    t.flush();
    expect(out[1]!.seq).toBe(1); // continued its own stream, not the seed
  });

  it('an older continuation record (no seq) starts at zero, exactly as before', () => {
    const out: RunLogSegment[] = [];
    const t = new RunTranscript((s) => out.push(...s));
    t.seedFrom(0);
    t.text('agent', 'x');
    t.flush();
    expect(out[0]!.seq).toBe(0);
  });
});
