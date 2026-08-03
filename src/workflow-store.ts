import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type ProjectManifest, type RunKind, RunKind as RunKindSchema } from '@noriq-dev/shared';
import { parse as parseToml } from 'smol-toml';
import type { logger as Logger } from './logger';
import { type DocReader, defaultDocReader } from './repo-context';

export const DEFAULT_USER_WORKFLOWS_DIR = path.join(os.homedir(), '.noriq', 'workflows');
export const WORKFLOW_TEMPLATE_MAX_CHARS = 32_000;
const WORKFLOW_DEFINITION_MAX_CHARS = 64_000;

export type WorkflowSourceTier = 'user-file' | 'project-manifest' | 'project-file';

/** A validated definition plus the source identity needed for diagnostics and lenient rendering. */
export interface LoadedWorkflowDefinition {
  base: RunKind;
  prompt: string | null;
  /** The file whose bytes supplied `prompt`; null means the base's bundled prompt is used. */
  promptSource: string | null;
  /** The TOML source that declared this workflow. */
  source: string;
  tier: WorkflowSourceTier;
}

/** One immutable, per-dispatch view. Callers keep it for the run rather than re-reading mid-run. */
export interface WorkflowCatalog {
  definitions: Readonly<Record<string, LoadedWorkflowDefinition>>;
}

export interface WorkflowStoreDeps {
  userDir?: string;
  /** Injectable filesystem seams; production still confines every read through openConfined. */
  list?: (dir: string) => Promise<string[]>;
  read?: DocReader;
  logger?: Pick<typeof Logger, 'debug' | 'info' | 'warn' | 'error'>;
}

interface FilePrompt {
  file: string;
}

interface RawDefinition {
  base?: unknown;
  prompt?: unknown;
}

const escapes = (root: string, abs: string): boolean => {
  const rel = path.relative(root, abs);
  return rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
};

const asFilePrompt = (value: unknown): FilePrompt | null => {
  if (!value || typeof value !== 'object') return null;
  const file = (value as { file?: unknown }).file;
  return typeof file === 'string' && file.length > 0 ? { file } : null;
};

const workflowName = (file: string): string => path.basename(file, '.toml');

/**
 * Read-at-use workflow definitions (RUN-192).
 *
 * The merge is deliberately rebuilt for every call: user files are the lower custom tier,
 * inline project.toml definitions override them, and dedicated project files override inline
 * definitions. Files are sorted before folding, so duplicate diagnostics and winners are stable.
 * A broken higher-tier file keeps a scope-based tombstone for its name; falling through to a
 * lower, potentially wider posture would turn a typo into a permission change.
 */
export class WorkflowStore {
  private readonly userDir: string;
  private readonly list: (dir: string) => Promise<string[]>;
  private readonly read: DocReader;
  private readonly log: Pick<typeof Logger, 'debug' | 'info' | 'warn' | 'error'>;

  constructor(deps: WorkflowStoreDeps = {}) {
    this.userDir = path.resolve(deps.userDir ?? DEFAULT_USER_WORKFLOWS_DIR);
    this.list = deps.list ?? (async (dir) => readdir(dir));
    this.read = deps.read ?? defaultDocReader;
    this.log = deps.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
  }

  async current(root: string, manifest: Pick<ProjectManifest, 'workflows'>): Promise<WorkflowCatalog> {
    const repoRoot = path.resolve(root);
    // Workflow names are filenames and therefore hostile keys (`__proto__`, `constructor`). A
    // null-prototype record makes assignment data rather than an Object.prototype mutation.
    const definitions = Object.create(null) as Record<string, LoadedWorkflowDefinition>;

    const apply = (name: string, next: LoadedWorkflowDefinition): void => {
      const previous = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
      if (previous) {
        this.log.warn('workflow definition shadowed by a higher-precedence source', {
          workflow: name,
          winner: next.source,
          shadowed: previous.source,
        });
      }
      definitions[name] = next;
    };

    for (const [name, definition] of await this.readDirectory(this.userDir, this.userDir, 'user-file')) {
      apply(name, definition);
    }

    const marker = path.join(repoRoot, '.noriq', 'project.toml');
    for (const [name, definition] of Object.entries(manifest.workflows ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      apply(name, {
        base: definition.base,
        prompt: definition.prompt,
        promptSource: definition.prompt === null ? null : marker,
        source: marker,
        tier: 'project-manifest',
      });
    }

    const projectDir = path.join(repoRoot, '.noriq', 'workflows');
    for (const [name, definition] of await this.readDirectory(projectDir, repoRoot, 'project-file')) {
      apply(name, definition);
    }

    return { definitions: Object.freeze(definitions) };
  }

  private async readDirectory(
    dir: string,
    confinementRoot: string,
    tier: Extract<WorkflowSourceTier, 'user-file' | 'project-file'>,
  ): Promise<Array<[string, LoadedWorkflowDefinition]>> {
    const names = await this.list(dir).catch(() => []);
    const files = names.filter((name) => name.endsWith('.toml')).sort((a, b) => a.localeCompare(b));
    const loaded: Array<[string, LoadedWorkflowDefinition]> = [];
    for (const fileName of files) {
      const source = path.join(dir, fileName);
      const name = workflowName(fileName);
      if (!name) continue;
      loaded.push([name, await this.readDefinition(name, source, confinementRoot, tier)]);
    }
    return loaded;
  }

  private async readDefinition(
    name: string,
    source: string,
    confinementRoot: string,
    tier: Extract<WorkflowSourceTier, 'user-file' | 'project-file'>,
  ): Promise<LoadedWorkflowDefinition> {
    let raw: RawDefinition;
    try {
      const text = await this.read(source, WORKFLOW_DEFINITION_MAX_CHARS, confinementRoot);
      if (text.length > WORKFLOW_DEFINITION_MAX_CHARS) throw new Error('definition is too large');
      raw = parseToml(text) as RawDefinition;
    } catch (err) {
      this.log.error('workflow definition could not be read or parsed — using the scope posture', {
        workflow: name,
        source,
        err: String(err),
      });
      return { base: 'scope', prompt: null, promptSource: null, source, tier };
    }

    const parsedBase = RunKindSchema.safeParse(raw.base);
    if (!parsedBase.success) {
      this.log.error('workflow definition has an invalid base — using the scope posture', {
        workflow: name,
        source,
      });
      return { base: 'scope', prompt: null, promptSource: null, source, tier };
    }

    if (raw.prompt === undefined || raw.prompt === null) {
      return { base: parsedBase.data, prompt: null, promptSource: null, source, tier };
    }
    if (typeof raw.prompt === 'string') {
      return {
        base: parsedBase.data,
        prompt: raw.prompt,
        promptSource: source,
        source,
        tier,
      };
    }

    const prompt = asFilePrompt(raw.prompt);
    if (!prompt) {
      this.log.error('workflow prompt must be text or { file = "..." } — using the base prompt', {
        workflow: name,
        source,
      });
      return { base: parsedBase.data, prompt: null, promptSource: null, source, tier };
    }

    const abs = path.resolve(path.dirname(source), prompt.file);
    if (escapes(confinementRoot, abs)) {
      this.log.error('workflow prompt file is outside its allowed root — refused', {
        workflow: name,
        source,
        promptFile: prompt.file,
        root: confinementRoot,
      });
      return { base: parsedBase.data, prompt: null, promptSource: null, source, tier };
    }
    try {
      // The production reader opens first, validates that descriptor with openConfined, and reads
      // from it. Keeping the read behind this injected seam preserves the same test strategy as
      // repository context without moving confinement into a pathname-only pre-check.
      const text = await this.read(abs, WORKFLOW_TEMPLATE_MAX_CHARS, confinementRoot);
      if (text.length > WORKFLOW_TEMPLATE_MAX_CHARS) throw new Error('prompt template is too large');
      return { base: parsedBase.data, prompt: text, promptSource: abs, source, tier };
    } catch (err) {
      this.log.error('workflow prompt file could not be read safely — using the base prompt', {
        workflow: name,
        source,
        promptFile: abs,
        err: String(err),
      });
      return { base: parsedBase.data, prompt: null, promptSource: null, source, tier };
    }
  }
}
