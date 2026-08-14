import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { runProcess } from "../../process.js";

const ignoredDirectories = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "target",
  "Binaries",
  "DerivedDataCache",
  "Intermediate",
  "Saved",
]);

export interface IndexSourceEntry {
  path: string;
  size?: number;
}

export interface IndexSource {
  readonly kind: string;
  list(): Promise<IndexSourceEntry[]>;
  read(
    path: string,
    maxBytes: number,
  ): Promise<{ bytes: Buffer; overLimit: boolean }>;
}

function safeRepositoryPath(path: string): string {
  if (path.includes("\\"))
    throw new Error(`index source path must use / separators: ${path}`);
  const normalized = path;
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new Error(`invalid repository path from index source: ${path}`);
  return normalized;
}

async function rawCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  maxBytes: number;
}): Promise<{ bytes: Buffer; overLimit: boolean; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, PWD: input.cwd },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let captured = 0;
    let overLimit = false;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      const remaining = Math.max(0, input.maxBytes + 1 - captured);
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        captured += kept.length;
      }
      if (size > input.maxBytes) overLimit = true;
    });
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const stderr = Buffer.concat(errors).toString("utf8");
      if (code !== 0)
        reject(
          new Error(
            `${input.command} ${input.args[0] ?? ""} failed: ${stderr || `exit ${code}`}`,
          ),
        );
      else
        resolveResult({
          bytes: Buffer.concat(chunks).subarray(0, input.maxBytes),
          overLimit,
          stderr,
        });
    });
  });
}

function confined(root: string, path: string): string {
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`))
    throw new Error(`index path escapes repository: ${path}`);
  return absolute;
}

export class FilesystemIndexSource implements IndexSource {
  readonly kind: string = "filesystem";
  constructor(protected readonly root: string) {}

  async list(): Promise<IndexSourceEntry[]> {
    const paths: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
        const absolute = join(directory, entry.name);
        const path = relative(this.root, absolute).split(sep).join("/");
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile()) paths.push(path);
      }
    };
    await walk(this.root);
    return paths.sort().map((path) => ({ path }));
  }

  async read(
    path: string,
    maxBytes: number,
  ): Promise<{ bytes: Buffer; overLimit: boolean }> {
    const bytes = await readFile(confined(this.root, path));
    return {
      bytes: bytes.subarray(0, maxBytes),
      overLimit: bytes.length > maxBytes,
    };
  }
}

export class GitIndexSource extends FilesystemIndexSource {
  override readonly kind = "git";
  private paths = new Set<string>();
  constructor(
    root: string,
    private readonly command = "git",
    private readonly revision = "HEAD",
  ) {
    super(root);
  }

  override async list(): Promise<IndexSourceEntry[]> {
    const result = await runProcess({
      command: this.command,
      args: [
        "ls-tree",
        "-r",
        "-z",
        "--full-tree",
        "--name-only",
        this.revision,
        "--",
      ],
      cwd: this.root,
      timeoutMs: 120_000,
      maxOutputBytes: 64 * 1024 * 1024,
    });
    if (result.exitCode !== 0)
      throw new Error(`git ls-tree failed: ${result.stderr || result.stdout}`);
    if (result.stdoutTruncated)
      throw new Error(
        "git index enumeration exceeded its bounded output limit",
      );
    const entries = result.stdout
      .split("\0")
      .filter(Boolean)
      .map(safeRepositoryPath)
      .sort()
      .map((path) => ({ path }));
    this.paths = new Set(entries.map((entry) => entry.path));
    return entries;
  }

  override async read(
    path: string,
    maxBytes: number,
  ): Promise<{ bytes: Buffer; overLimit: boolean }> {
    const normalized = safeRepositoryPath(path);
    if (!this.paths.has(normalized))
      throw new Error(`Git index source refuses unenumerated path ${path}`);
    return rawCommand({
      command: this.command,
      args: ["show", `${this.revision}:${normalized}`],
      cwd: this.root,
      maxBytes,
    });
  }
}

interface PerforceRecord {
  depotFile: string;
  clientFile: string;
  headAction: string;
  fileSize?: number;
}

function perforceRecords(raw: string): PerforceRecord[] {
  return raw.split(/\n\s*\n/).flatMap((block) => {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const match = line.match(/^\.\.\. (\S+) (.*)$/);
      if (match?.[1] && match[2] !== undefined) fields.set(match[1], match[2]);
    }
    const depotFile = fields.get("depotFile");
    const clientFile = fields.get("clientFile");
    const headAction = fields.get("headAction");
    if (!depotFile || !clientFile || !headAction) return [];
    const size = fields.get("fileSize");
    return [
      {
        depotFile,
        clientFile,
        headAction,
        ...(size && /^\d+$/.test(size) ? { fileSize: Number(size) } : {}),
      },
    ];
  });
}

export class PerforceIndexSource implements IndexSource {
  readonly kind = "perforce";
  private readonly depotFiles = new Map<string, string>();

  constructor(
    private readonly root: string,
    private readonly command = "p4",
    private readonly revision = "now",
    private readonly invoke: typeof runProcess = runProcess,
    private readonly invokeRaw: typeof rawCommand = rawCommand,
  ) {}

  async list(): Promise<IndexSourceEntry[]> {
    const result = await this.invoke({
      command: this.command,
      args: ["-Ztag", "fstat", "-Ol", `...@${this.revision}`],
      cwd: this.root,
      env: { ...process.env, PWD: this.root },
      timeoutMs: 120_000,
      maxOutputBytes: 64 * 1024 * 1024,
    });
    if (result.exitCode !== 0)
      throw new Error(`p4 fstat failed: ${result.stderr || result.stdout}`);
    if (result.stdoutTruncated)
      throw new Error(
        "Perforce index enumeration exceeded its bounded output limit",
      );
    const entries: IndexSourceEntry[] = [];
    this.depotFiles.clear();
    for (const record of perforceRecords(result.stdout)) {
      if (record.headAction === "delete" || record.headAction === "move/delete")
        continue;
      const path = relative(this.root, record.clientFile).split(sep).join("/");
      if (!path || path === ".." || path.startsWith("../")) continue;
      const normalized = safeRepositoryPath(path);
      this.depotFiles.set(normalized, record.depotFile);
      entries.push({
        path: normalized,
        ...(record.fileSize === undefined ? {} : { size: record.fileSize }),
      });
    }
    return entries.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  }

  async read(
    path: string,
    maxBytes: number,
  ): Promise<{ bytes: Buffer; overLimit: boolean }> {
    const normalized = safeRepositoryPath(path);
    const depotFile = this.depotFiles.get(normalized);
    if (!depotFile)
      throw new Error(
        `Perforce index source refuses unenumerated path ${path}`,
      );
    return this.invokeRaw({
      command: this.command,
      args: ["print", "-q", `${depotFile}@${this.revision}`],
      cwd: this.root,
      maxBytes,
    });
  }
}

export class DiversionIndexSource extends FilesystemIndexSource {
  override readonly kind = "diversion";
}

export function createIndexSource(
  kind: string,
  root: string,
  commands: { git?: string; perforce?: string } = {},
  revision?: string,
): IndexSource {
  if (kind === "git") return new GitIndexSource(root, commands.git, revision);
  if (kind === "perforce")
    return new PerforceIndexSource(root, commands.perforce, revision);
  if (kind === "diversion") return new DiversionIndexSource(root);
  return new FilesystemIndexSource(root);
}
