/**
 * RUN-248: two things `stage-facts.ts`'s cost-availability inference and the capability
 * declarations in `drivers/types.ts` must never silently disagree about.
 *
 * `stage-facts.ts`'s `costReported = t.modelUsage != null || t.costUsd > 0` is an INFERENCE over a
 * `DriverTelemetry` snapshot, not a read of `DriverCapabilities.perModelTelemetry` — the two are
 * different sources of truth that happen, today, to agree for both shipped drivers. This file is
 * what HOLDS that agreement: a future third driver whose declaration and telemetry disagree (says
 * `perModelTelemetry: true` but sometimes ships tokens with neither `modelUsage` nor a positive
 * `costUsd`, or the reverse) fails HERE, in the driver's own conformance row, rather than reporting
 * a silently wrong stage-fact status with nothing to catch it (`stage-facts.ts`'s own doc comment
 * names this file for exactly that reason).
 *
 * The other half (below) pins the Claude/Codex ASYMMETRIES as differences the codebase has already
 * decided to keep — this task's own scope: "model mix/cost differences, resume behavior, hooks, and
 * timing evidence must not be normalized into false parity." A test that merely encoded today's
 * VALUES would still pass if a future change quietly narrowed one driver toward the other's
 * behaviour; asserting the DIFFERENCE fails exactly when that happens.
 */

import { describe, expect, it } from 'vitest';
import { ClaudeDriver } from '../src/drivers/claude';
import { CodexDriver } from '../src/drivers/codex';
import type { DriverCapabilities, DriverTelemetry } from '../src/drivers/types';
import { stageFactFromTelemetry } from '../src/stage-facts';

// Constructed with no deps — neither driver spawns anything from its constructor (the real SDK
// query / codex app-server process is only touched from `start()`), so reading `.capabilities`
// needs no live session, no fake transport, nothing injected. This is the discretion call RUN-248's
// spec named directly: "read the exported driver objects/factories directly if they expose
// capabilities statically."
const claude = new ClaudeDriver();
const codex = new CodexDriver();

describe('Claude vs Codex — pinned capability ASYMMETRIES, not normalized parity (RUN-110/248)', () => {
  it('toolHooks: Claude wires the in-process lock hooks (PreToolUse deny + Stop release, RUN-101); Codex has none and relies on the hard floor alone (RUN-102)', () => {
    expect(claude.capabilities.toolHooks).toBe(true);
    expect(codex.capabilities.toolHooks).toBe(false);
  });

  it('resumableSession: a parked Claude run resumes with its context intact (RUN-30); a parked Codex run has no session to resume and restarts from scratch', () => {
    expect(claude.capabilities.resumableSession).toBe(true);
    expect(codex.capabilities.resumableSession).toBe(false);
  });

  it('perModelTelemetry: Claude attributes spend per model (RUN-59); Codex spend always lands in the (unattributed) bucket (RUN-86)', () => {
    expect(claude.capabilities.perModelTelemetry).toBe(true);
    expect(codex.capabilities.perModelTelemetry).toBe(false);
  });

  it('steer and interrupt do NOT currently diverge — recorded explicitly so a reader does not go looking for a fourth asymmetry that is not there', () => {
    // RUN-248's own locked decision anticipated "whichever of steer/interrupt diverge" as a fourth
    // asymmetry alongside the three above. As of this task, neither one does: Claude steers over its
    // streaming `pushInput` and Codex over `turn/steer` RPC, and both drivers support a hard
    // `interrupt()`. Asserting EQUALITY here (not just "both true", which a copy-paste typo could
    // still pass) is what turns a future asymmetry into a caught, deliberate capability change
    // instead of a silent one — this test starts failing the day either driver's posture moves.
    expect(claude.capabilities.steer).toBe(codex.capabilities.steer);
    expect(claude.capabilities.interrupt).toBe(codex.capabilities.interrupt);
  });
});

interface DriverUnderTest {
  name: string;
  capabilities: DriverCapabilities;
  /**
   * A realistic `DriverTelemetry` snapshot for a session of THIS driver that actually spent —
   * shaped the way the driver's own telemetry-construction code actually produces it, not a
   * hand-waved fixture:
   *   - Claude: `drivers/claude.ts`'s `telemetryFromResult`, the per-model branch (`modelUsage`
   *     present, `costUsd` the SDK's own `total_cost_usd` sum) — the normal, non-fallback path.
   *   - Codex: `drivers/codex.ts` never emits `modelUsage` and never sets `costUsd` off anything
   *     (the app-server's usage notification carries no cost, no model key — see that file's own
   *     `CodexEvent` doc) — `costUsd` stays at `zeroTelemetry()`'s default of exactly `0`.
   */
  spendingTelemetry: DriverTelemetry;
}

const DRIVERS: DriverUnderTest[] = [
  {
    name: 'claude',
    capabilities: claude.capabilities,
    spendingTelemetry: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.1,
      numTurns: 1,
      modelUsage: {
        'claude-opus-4-8': {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.1,
        },
      },
    },
  },
  {
    name: 'codex',
    capabilities: codex.capabilities,
    spendingTelemetry: {
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
      costUsd: 0,
      numTurns: 1,
    },
  },
];

describe.each(DRIVERS)(
  '$name — stage-facts.ts cost inference agrees with its declared DriverCapabilities.perModelTelemetry',
  ({ name, capabilities, spendingTelemetry }) => {
    it(`declares perModelTelemetry=${String(capabilities.perModelTelemetry)}, and stageFactFromTelemetry reports the matching costUSD status for a real spending session`, () => {
      const fact = stageFactFromTelemetry('primary', spendingTelemetry);
      // A driver's own per-model telemetry is exactly what stage-facts.ts's inference is built to
      // read: `costReported = t.modelUsage != null || t.costUsd > 0`. A driver that attributes spend
      // per model (`perModelTelemetry: true`) is expected to report cost as `complete` for a session
      // that spent; one that cannot (`false`) is expected to report `unavailable` — never a `0` that
      // would assert the session was free.
      const expectedStatus = capabilities.perModelTelemetry ? 'complete' : 'unavailable';
      expect(fact.tokens.status, `${name}: a spending session must always report tokens as complete`).toBe(
        'complete',
      );
      expect(
        fact.costUSD.status,
        `${name}: DriverCapabilities.perModelTelemetry=${capabilities.perModelTelemetry} but the cost inference reported '${fact.costUSD.status}' — declaration and inference have drifted apart`,
      ).toBe(expectedStatus);
    });
  },
);

describe('a KNOWN, pre-existing gap the conformance test above does not close (RUN-248 audit finding)', () => {
  it("Claude's no-modelUsage fallback path can under-report a genuine $0 cost as `unavailable`, identical to the Codex shape", () => {
    // RUN-248's locked decision (audited before this file was written) reads: "the case I expected
    // to be broken — a Claude session that genuinely cost ~0 being reported `unavailable` as if the
    // driver never spoke — does not arise, because Claude reports `modelUsage` whenever it spends."
    // That holds for the branch `DRIVERS[0]` above exercises (`telemetryFromResult`'s per-model
    // path). It does NOT hold for the OTHER branch that same function has: the fallback for a result
    // with no `modelUsage` at all (an older SDK, or a result shape not yet seen — `claude.ts`'s own
    // comment), which still sets `costUsd: total_cost_usd` verbatim. If that arm ever fires for a
    // session that genuinely cost exactly $0 — real tokens, a real reported cost of zero — the
    // inference below reads `unavailable`, identical to Codex, even though Claude DID report a cost.
    //
    // Not fixed here: `telemetryFromResult`'s own comment says the current SDK does not take this
    // arm, so there is nothing live to repair, and RUN-248's locked decision explicitly rejects
    // threading a capability through `RunTally.record`'s call sites for a case that does not arise
    // today. Pinned as a test so it stays a documented, known limitation rather than a claim nobody
    // checked — see `stage-facts.ts`'s own comment beside `costReported` for the same note.
    const claudeFallbackZeroCost: DriverTelemetry = {
      inputTokens: 3,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0, // telemetryFromResult's fallback arm, verbatim from a real `total_cost_usd: 0`
      numTurns: 1,
      // no modelUsage — the exact fallback shape
    };
    const fact = stageFactFromTelemetry('primary', claudeFallbackZeroCost);
    expect(fact.tokens.status).toBe('complete');
    // This is the imprecise part: Claude's capability says perModelTelemetry: true, yet this
    // specific (fallback-only, currently unreachable) shape reads exactly like Codex's permanent one.
    expect(fact.costUSD.status).toBe('unavailable');
    expect(claude.capabilities.perModelTelemetry).toBe(true); // the declaration this shape defies
  });
});
