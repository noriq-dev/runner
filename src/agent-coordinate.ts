import { RunEffort } from '@noriq-dev/shared';

/**
 * The agent coordinate (RUN-112): one dotted string that names WHICH driver, WHICH model, and how
 * hard to think — `claude.opus-4_8.high`, `codex.gpt-5_6-sol.high` — replacing the separate
 * tool/model/effort triple as the canonical selector. The triple is DERIVED from it, not the other
 * way round.
 *
 * Grammar: `<tool>[.<model>[.<effort>]]`, split on `.`.
 *   - tool   — the driver id ('claude', 'codex', or a future driver). Required, non-empty.
 *   - model  — the vendor model, with every `.` written as `_` so a dotted version stays ONE
 *              segment: `opus-4_8` ⟷ `opus-4.8`, `gpt-5_6-sol` ⟷ `gpt-5.6-sol`. This is a purely
 *              mechanical spelling of the model STRING handed to the driver — it is not a catalog
 *              lookup, so a model whose real id contains a literal underscore is not representable
 *              (none of the vendors' ids do; they use dashes). Empty = unset (fall through).
 *   - effort — one of RunEffort; validated. Empty = unset.
 *
 * An unset trailing segment is simply omitted (`claude.opus-4_8`, `claude`); an unset MIDDLE
 * segment is an empty one (`claude..high` = default model, explicit effort). `null` on a field
 * means "not chosen here" — a resolver fills it from the repo defaults, then the driver's own
 * default (see `mergeCoordinate`).
 */
export interface AgentCoordinate {
  /** Driver id — 'claude', 'codex', or a future driver. Never empty on a parsed coordinate. */
  tool: string;
  /** Vendor model string (dots restored), or null when this coordinate does not pin one. */
  model: string | null;
  /** Reasoning-effort intent, or null when this coordinate does not pin one. */
  effort: RunEffort | null;
}

const escapeModel = (model: string): string => model.replaceAll('.', '_');
const unescapeModel = (segment: string): string => segment.replaceAll('_', '.');

/** A segment the user left blank (`''`) reads as "unset", never as an empty model/effort. */
const orNull = (segment: string | undefined): string | null =>
  segment == null || segment === '' ? null : segment;

/**
 * Parse a coordinate. Throws on a malformed one: empty, empty tool, more than three segments, or an
 * effort outside RunEffort. Use `tryParseCoordinate` where a bad value should degrade rather than
 * throw (e.g. reading a hand-edited manifest).
 */
export function parseCoordinate(raw: string): AgentCoordinate {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('empty agent coordinate');
  const segments = trimmed.split('.');
  if (segments.length > 3) {
    throw new Error(
      `agent coordinate "${raw}" has ${segments.length} segments — expected <tool>[.<model>[.<effort>]] (a dotted model version escapes its dots as underscores)`,
    );
  }
  const tool = segments[0] ?? '';
  if (!tool) throw new Error(`agent coordinate "${raw}" has no tool segment`);
  const modelSeg = orNull(segments[1]);
  const effortSeg = orNull(segments[2]);
  let effort: RunEffort | null = null;
  if (effortSeg != null) {
    const parsed = RunEffort.safeParse(effortSeg);
    if (!parsed.success) {
      throw new Error(
        `agent coordinate "${raw}" has effort "${effortSeg}" — expected one of ${RunEffort.options.join(' | ')}`,
      );
    }
    effort = parsed.data;
  }
  return { tool, model: modelSeg == null ? null : unescapeModel(modelSeg), effort };
}

/** Non-throwing `parseCoordinate` — returns null on any malformed input. */
export function tryParseCoordinate(raw: string): AgentCoordinate | null {
  try {
    return parseCoordinate(raw);
  } catch {
    return null;
  }
}

/**
 * Render a coordinate back to its string form — the inverse of `parseCoordinate`. Trailing unset
 * segments are dropped; an unset model with a set effort keeps the empty middle (`claude..high`).
 */
export function formatCoordinate(c: AgentCoordinate): string {
  const model = c.model == null ? '' : escapeModel(c.model);
  if (c.effort != null) return `${c.tool}.${model}.${c.effort}`;
  if (model !== '') return `${c.tool}.${model}`;
  return c.tool;
}

/**
 * Build a coordinate from the legacy tool/model/effort triple (RUN-112 back-compat): the shape a
 * dispatch that predates the coordinate still sends. A pure re-packaging — no validation, because
 * the triple's own fields were already validated on the wire.
 */
export function coordinateFromParts(
  tool: string,
  model: string | null | undefined,
  effort: RunEffort | null | undefined,
): AgentCoordinate {
  return { tool, model: model ?? null, effort: effort ?? null };
}

/**
 * Segment-wise fallthrough: take `primary`, and fill each field it leaves null from the first
 * fallback that pins it — the "dispatch → repo defaults → driver default" resolution order. The
 * tool comes from `primary` (a coordinate always names its driver); a fallback tool only fills a
 * primary that somehow has none.
 */
export function mergeCoordinate(
  primary: AgentCoordinate,
  ...fallbacks: Array<Partial<AgentCoordinate> | null | undefined>
): AgentCoordinate {
  let { tool, model, effort } = primary;
  for (const f of fallbacks) {
    if (!f) continue;
    if (!tool && f.tool) tool = f.tool;
    if (model == null && f.model != null) model = f.model;
    if (effort == null && f.effort != null) effort = f.effort;
  }
  return { tool, model, effort };
}
