import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type ProjectManifest,
  type RunKind,
  RunKind as RunKindSchema,
  type WorkflowStages,
  WorkflowStages as WorkflowStagesSchema,
} from '@noriq-dev/shared';
import { parse as parseToml } from 'smol-toml';
import type { logger as Logger } from './logger';
import { type DocReader, defaultDocReader } from './repo-context';
import { isStageCoordinateKey } from './workflow';

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
  /** The declared pipeline (RUN-193, contract v2 `WorkflowDef.stages`) — array or `[stages.<name>]`
   *  table form, both carrying per-stage agent coordinates. Null = inherit the base's stage list.
   *  `resolveWorkflow` clamps it; a value that could not be parsed degrades to null (keeping the
   *  declared posture), never a wider one. */
  stages: WorkflowStages | null;
  /** One human line for the dispatch surface (RUN-195/PLNR-240). Cosmetic — nothing executes it;
   *  it rides the repo report so a workflow picker can say what a name is for. Null = undeclared. */
  description: string | null;
  /**
   * Locally declared protocol opt-ins. They are not advertised automatically: daemon activation
   * must separately prove the complete capability is available for this repo.
   */
  capabilities?: readonly string[];
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
  description?: unknown;
  stages?: unknown;
  capabilities?: unknown;
}

const MISSION_WORKFLOW_CAPABILITY = 'mission.v2';

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
      // The v2 contract lets prompt be `{ file = ... }` at the inline tier too, but the runner's
      // file-prompt support (RUN-192) deliberately lives in dedicated workflow files, where the
      // confinement root is unambiguous. Until that is wired, fall back to the base prompt loudly
      // rather than half-resolve a path — the declared posture and description still hold.
      const prompt = typeof definition.prompt === 'string' ? definition.prompt : null;
      if (definition.prompt !== null && prompt === null) {
        this.log.warn(
          'inline [workflows.*] file prompts are not wired — move it to .noriq/workflows/<name>.toml',
          { workflow: name },
        );
      }
      apply(name, {
        base: definition.base,
        prompt,
        promptSource: prompt === null ? null : marker,
        // Already `WorkflowStages | null` off the zod-validated manifest — re-run through the same
        // name check so an inline typo warns like a file one, then carry it (RUN-193).
        stages: this.parseStages(definition.stages, name, marker),
        description: definition.description,
        capabilities: [],
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
      return {
        base: 'scope',
        prompt: null,
        promptSource: null,
        stages: null,
        description: null,
        capabilities: [],
        source,
        tier,
      };
    }

    const parsedBase = RunKindSchema.safeParse(raw.base);
    if (!parsedBase.success) {
      this.log.error('workflow definition has an invalid base — using the scope posture', {
        workflow: name,
        source,
      });
      // The tombstone stands for "broken definition"; carrying its description onto the
      // advertisement would dress up a definition the daemon refused to load.
      return {
        base: 'scope',
        prompt: null,
        promptSource: null,
        stages: null,
        description: null,
        capabilities: [],
        source,
        tier,
      };
    }

    // The declared pipeline (RUN-193). Parsed once here and carried on every valid-base return
    // below. A malformed value degrades to null (the base's own list) with a warn — a broken
    // `stages` costs the declaration its pipeline, never its posture, the same rule the whole store
    // runs on. `resolveWorkflow` does the clamp; this only validates the shape and the names.
    const stages = this.parseStages(raw.stages, name, source);
    const capabilities = this.parseCapabilities(raw.capabilities, parsedBase.data, name, source);

    // One human line for the dispatch surface (RUN-195). Cosmetic, so a wrong TYPE degrades to
    // "undeclared" with a warn rather than costing the definition its declared posture.
    const description = typeof raw.description === 'string' ? raw.description : null;
    if (raw.description !== undefined && raw.description !== null && description === null) {
      this.log.warn('workflow description must be a string — ignoring it', { workflow: name, source });
    }

    if (raw.prompt === undefined || raw.prompt === null) {
      return {
        base: parsedBase.data,
        prompt: null,
        promptSource: null,
        stages,
        description,
        capabilities,
        source,
        tier,
      };
    }
    if (typeof raw.prompt === 'string') {
      return {
        base: parsedBase.data,
        prompt: raw.prompt,
        promptSource: source,
        stages,
        description,
        capabilities,
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
      return {
        base: parsedBase.data,
        prompt: null,
        promptSource: null,
        stages,
        description,
        capabilities,
        source,
        tier,
      };
    }

    const abs = path.resolve(path.dirname(source), prompt.file);
    if (escapes(confinementRoot, abs)) {
      this.log.error('workflow prompt file is outside its allowed root — refused', {
        workflow: name,
        source,
        promptFile: prompt.file,
        root: confinementRoot,
      });
      return {
        base: parsedBase.data,
        prompt: null,
        promptSource: null,
        stages,
        description,
        capabilities,
        source,
        tier,
      };
    }
    try {
      // The production reader opens first, validates that descriptor with openConfined, and reads
      // from it. Keeping the read behind this injected seam preserves the same test strategy as
      // repository context without moving confinement into a pathname-only pre-check.
      const text = await this.read(abs, WORKFLOW_TEMPLATE_MAX_CHARS, confinementRoot);
      if (text.length > WORKFLOW_TEMPLATE_MAX_CHARS) throw new Error('prompt template is too large');
      return {
        base: parsedBase.data,
        prompt: text,
        promptSource: abs,
        stages,
        description,
        capabilities,
        source,
        tier,
      };
    } catch (err) {
      this.log.error('workflow prompt file could not be read safely — using the base prompt', {
        workflow: name,
        source,
        promptFile: abs,
        err: String(err),
      });
      return {
        base: parsedBase.data,
        prompt: null,
        promptSource: null,
        stages,
        description,
        capabilities,
        source,
        tier,
      };
    }
  }

  private parseCapabilities(
    raw: unknown,
    base: RunKind,
    workflow: string,
    source: string,
  ): readonly string[] {
    if (raw === undefined || raw === null) return [];
    if (
      !Array.isArray(raw) ||
      raw.length > 16 ||
      raw.some((value) => typeof value !== 'string' || value !== MISSION_WORKFLOW_CAPABILITY)
    ) {
      this.log.error('workflow capabilities are invalid — advertising no protocol opt-in', {
        workflow,
        source,
      });
      return [];
    }
    if (new Set(raw).size !== raw.length) {
      this.log.error('workflow capabilities contain duplicates — advertising no protocol opt-in', {
        workflow,
        source,
      });
      return [];
    }
    if (raw.includes(MISSION_WORKFLOW_CAPABILITY) && base !== 'build') {
      this.log.error('mission.v2 requires a build-posture workflow — capability ignored', {
        workflow,
        source,
        base,
      });
      return [];
    }
    return Object.freeze([...raw]);
  }

  /**
   * Validate a raw `stages` value (RUN-193) against the vendored `WorkflowStages` schema and warn
   * about keys that name no stage. Returns the validated union, or null — a malformed value costs
   * the declaration its pipeline (it inherits the base's), never its posture. Unknown keys are kept
   * in the returned value and dropped later by `resolveWorkflow`'s clamp; warning here is where a
   * logger exists and where the author's file is named.
   */
  private parseStages(raw: unknown, name: string, source: string): WorkflowStages | null {
    if (raw === undefined || raw === null) return null;
    const parsed = WorkflowStagesSchema.safeParse(raw);
    if (!parsed.success) {
      this.log.warn('workflow stages must be an array of names or a table of [stages.<name>] — ignoring it', {
        workflow: name,
        source,
      });
      return null;
    }
    const keys = Array.isArray(parsed.data) ? parsed.data : Object.keys(parsed.data);
    const unknown = keys.filter((k) => !isStageCoordinateKey(k));
    if (unknown.length) {
      this.log.warn('workflow declares stage names the runner does not run — they are ignored', {
        workflow: name,
        source,
        unknown,
      });
    }
    return parsed.data;
  }
}
