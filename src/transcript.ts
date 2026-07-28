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
  /** Which step of a decomposed run said it (RUN-150). Null for an undecomposed run, which is
   *  most of them, and for anything the parent's own gates say after the chain ends. */
  step: string | null;
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
  private buf: { role: RunLogRole; round: number | null; step: string | null; text: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly sink: (segments: RunLogSegment[]) => void) {}

  /**
   * The next seq this transcript will hand out — what a continuation has to resume FROM (RUN-183).
   *
   * The server stores segments under `PRIMARY KEY (run_id, seq)` and writes them with `INSERT OR
   * IGNORE`, which is what makes redelivery after a reconnect a no-op. A second sitting of the
   * same run that restarts its numbering at 0 therefore collides with every row the first sitting
   * wrote, and its transcript is discarded in silence — measured live at 49 minutes of work and
   * zero recorded segments.
   */
  nextSeq(): number {
    return this.seq;
  }

  /**
   * Continue the numbering from a previous sitting (RUN-183).
   *
   * Refuses once anything has been emitted: a transcript that has already spoken has a stream a
   * reader is following, and moving its numbering underneath them would reorder what they see.
   * Idempotent and safe to call before the first segment, which is the only moment it applies.
   */
  seedFrom(seq: number): void {
    // Only before anything has been EMITTED. Buffered text has not been sent yet, so it is no
    // obstacle — it will simply go out under the resumed numbering, which is what we want.
    // Refusing after the fact matters: a transcript that has already spoken has a reader following
    // it, and moving its numbering underneath them would reorder what they see.
    if (this.seq === 0 && seq > 0) this.seq = seq;
  }

  /** Streamed output from a session. Buffered; consecutive same-voice text coalesces. */
  /**
   * Streamed output from a session. Buffered; consecutive same-voice text coalesces.
   *
   * `step` (RUN-150) travels WITH the call rather than living on this object, and that is not a
   * style choice — a mutable "current step" is correct only while exactly one session speaks at a
   * time. The moment steps overlap, changing it for one would relabel the other's output, and the
   * bug would be a transcript that reads plausibly and attributes the wrong work to the wrong step.
   * The session already knows which step it is; asking it costs one argument.
   */
  text(role: RunLogRole, text: string, round: number | null = null, step: string | null = null): void {
    if (!text) return;
    if (this.buf && (this.buf.role !== role || this.buf.round !== round || this.buf.step !== step)) {
      this.flush();
    }
    if (!this.buf) this.buf = { role, round, step, text: '' };
    this.buf.text += text;
    if (this.buf.text.length >= SEGMENT_TEXT_CAP) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_AFTER_MS);
      this.timer.unref?.();
    }
  }

  /** A daemon milestone ("verify command failed", "reviewer verdict: FAIL round 1", …).
   *  Flushes whatever voice was speaking first, so the ordering a human reads is real. */
  milestone(text: string, step: string | null = null): void {
    this.flush();
    this.emit([{ role: 'system', round: null, step, text }]);
  }

  /** Push everything buffered out now (voice switch, session end, terminal report). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.buf) return;
    const { role, round, step, text } = this.buf;
    this.buf = null;
    // A single oversized buffer becomes several segments, never a rejected frame.
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += SEGMENT_TEXT_CAP) parts.push(text.slice(i, i + SEGMENT_TEXT_CAP));
    this.emit(parts.map((p) => ({ role, round, step, text: p })));
  }

  /** Terminal: flush and stop the timer. The instance may still be reused by an in-process
   *  resume (the supervisor keys transcripts by runId), which keeps seqs monotonic. */
  end(): void {
    this.flush();
  }

  private emit(
    items: Array<{ role: RunLogRole; round: number | null; step: string | null; text: string }>,
  ): void {
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
