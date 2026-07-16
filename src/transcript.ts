// The run TRANSCRIPT emitter (RUN-74). Before this, the dashboard's log surface was one
// last-writer-wins logTail blob from the core agent — after an inline-reviewer refusal, the
// reviewer's report (the one thing a human needs to read) never reached the server at all.
// This emits the whole conversation as an append-only, role-labeled stream: the builder's
// turns, each reviewer round, the verify command's output, and the daemon's own milestones.

export type RunLogRole = 'agent' | 'reviewer' | 'verify' | 'system';

export interface RunLogSegment {
  seq: number;
  role: RunLogRole;
  round: number | null;
  text: string;
  at: string;
}

/** Wire caps from the shared run.log frame — enforced HERE so a chatty agent turns into
 *  more segments, never into a frame the server's schema rejects. */
const SEGMENT_TEXT_CAP = 8000; // headroom under the schema's 16384
const FLUSH_AFTER_MS = 2500;

/**
 * One run's transcript. Buffers per (role, round) so the stream reads as turns rather than
 * the process's write cadence, and flushes on voice switch, size, a quiet interval, or a
 * milestone. Seqs are monotonic per instance — the server dedups on (runId, seq), which is
 * what makes redelivery after a reconnect a no-op. Everything here is best-effort by
 * construction: a transcript must never gate a run, so the sink is fire-and-forget.
 */
export class RunTranscript {
  private seq = 0;
  private buf: { role: RunLogRole; round: number | null; text: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly sink: (segments: RunLogSegment[]) => void) {}

  /** Streamed output from a session. Buffered; consecutive same-voice text coalesces. */
  text(role: RunLogRole, text: string, round: number | null = null): void {
    if (!text) return;
    if (this.buf && (this.buf.role !== role || this.buf.round !== round)) this.flush();
    if (!this.buf) this.buf = { role, round, text: '' };
    this.buf.text += text;
    if (this.buf.text.length >= SEGMENT_TEXT_CAP) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_AFTER_MS);
      this.timer.unref?.();
    }
  }

  /** A daemon milestone ("verify command failed", "reviewer verdict: FAIL round 1", …).
   *  Flushes whatever voice was speaking first, so the ordering a human reads is real. */
  milestone(text: string): void {
    this.flush();
    this.emit([{ role: 'system', round: null, text }]);
  }

  /** Push everything buffered out now (voice switch, session end, terminal report). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.buf) return;
    const { role, round, text } = this.buf;
    this.buf = null;
    // A single oversized buffer becomes several segments, never a rejected frame.
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += SEGMENT_TEXT_CAP) parts.push(text.slice(i, i + SEGMENT_TEXT_CAP));
    this.emit(parts.map((p) => ({ role, round, text: p })));
  }

  /** Terminal: flush and stop the timer. The instance may still be reused by an in-process
   *  resume (the supervisor keys transcripts by runId), which keeps seqs monotonic. */
  end(): void {
    this.flush();
  }

  private emit(items: Array<{ role: RunLogRole; round: number | null; text: string }>): void {
    if (!items.length) return;
    const at = new Date().toISOString();
    try {
      this.sink(items.map((it) => ({ seq: this.seq++, ...it, at })));
    } catch {
      /* a transcript must never gate a run */
    }
  }
}

/** The no-op twin, for a daemon wired without a reportLog sink (old config, tests). Callers
 *  hold one code path; absence of a sink must not mean null-checks at every wire point. */
export const nullTranscript = (): RunTranscript => new RunTranscript(() => {});
