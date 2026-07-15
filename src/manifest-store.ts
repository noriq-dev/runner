import type { ProjectManifest } from '@noriq-dev/shared';
import { loadManifest } from './discovery';
import type { logger as Logger } from './logger';

/**
 * A repo's committed manifest, re-read from disk every time a Run needs it.
 *
 * `.noriq/project.toml` is config that lives IN the repo — edited, committed, pulled,
 * and (with [land]) landed by agents. A daemon that snapshots it at discovery makes
 * every edit a lie until someone remembers to restart, which is exactly how a stale
 * permission profile or verify command outlives the change that was supposed to fix it.
 *
 * Read-at-use rather than a file watcher, deliberately:
 *   * a watcher is a NOTIFICATION, not a source of truth — reading at the moment the
 *     value is used is what actually makes the run obey the current config;
 *   * fs.watch is famously uneven across platforms and editors (atomic-rename saves fire
 *     on the directory, not the file), so a missed event would silently reintroduce the
 *     staleness this exists to remove;
 *   * a Run's config must not change halfway through it. Pinning at start and holding for
 *     the duration is the property you want anyway.
 *
 * The cost is one small file read per run, against a run that spawns an agent and runs a
 * test suite. It does not register.
 */
export interface ManifestStoreDeps {
  /** Injectable for tests; defaults to reading the real marker. */
  load?: (root: string) => Promise<ProjectManifest | null>;
  logger?: Pick<typeof Logger, 'debug' | 'info' | 'warn' | 'error'>;
}

/** Top-level sections worth naming when the file changes under us. */
const SECTIONS = ['key', 'verify', 'tool', 'defaultBranch', 'land', 'permissions'] as const;

/** Which parts of the manifest actually differ. */
export function changedSections(a: ProjectManifest, b: ProjectManifest): string[] {
  return SECTIONS.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

export class ManifestStore {
  private readonly load: (root: string) => Promise<ProjectManifest | null>;
  private readonly log: Pick<typeof Logger, 'debug' | 'info' | 'warn' | 'error'>;
  /** The last manifest we successfully applied, per repo root. */
  private readonly applied = new Map<string, ProjectManifest>();

  constructor(deps: ManifestStoreDeps = {}) {
    this.load = deps.load ?? loadManifest;
    this.log = deps.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
  }

  /** Seed from discovery, so the first run doesn't report a spurious change. */
  seed(root: string, manifest: ProjectManifest): void {
    this.applied.set(root, manifest);
  }

  /**
   * The manifest this Run should execute under. Re-read now; on a broken or missing
   * file, keep the last good one and say so loudly — a typo mid-session shouldn't take
   * every dispatch down with it, but it must not pass unnoticed either.
   */
  async current(root: string): Promise<ProjectManifest | null> {
    const prev = this.applied.get(root) ?? null;
    const next = await this.load(root).catch(() => null);

    if (!next) {
      if (prev) {
        this.log.error('project.toml is missing or no longer valid — running under the last good config', {
          root,
        });
        return prev;
      }
      return null;
    }

    if (prev) {
      const changed = changedSections(prev, next);
      if (changed.length) {
        // `permissions` and `land` ARE the security floor. With [land] pointed at a
        // branch, an agent can land an edit to this file and the next run would obey it —
        // so a change to either gets said out loud rather than folded into a debug line.
        const securityRelevant = changed.filter((c) => c === 'permissions' || c === 'land');
        if (securityRelevant.length) {
          this.log.warn('project.toml changed the SECURITY floor — applying it from this run on', {
            root,
            changed: securityRelevant,
            land: next.land?.branch ?? null,
          });
        }
        this.log.info('project.toml changed — this run uses the new config (no restart needed)', {
          root,
          changed,
        });
      }
    }

    this.applied.set(root, next);
    return next;
  }
}
