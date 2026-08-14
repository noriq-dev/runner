import { createHash } from "node:crypto";
import { buildEntityUri, type StagedRow } from "@noriq-dev/shared";
import type { ProjectConfig } from "../../config.js";
import type { IndexSource } from "./source.js";

const deniedSegments = new Set([
  ".git",
  ".noriq-secrets",
  "node_modules",
  "dist",
  "build",
  "target",
  "Binaries",
  "DerivedDataCache",
  "Intermediate",
  "Saved",
]);
const deniedNames = [
  /^\.env(?:\.|$)/i,
  /credentials?/i,
  /secrets?/i,
  /(?:^|[._-])private[-_.]?key/i,
  /\.(?:pem|p12|pfx|key|keystore|jks)$/i,
  /^(?:id_rsa|id_ed25519)$/i,
];
const qualityExcluded =
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|.*\.(?:uasset|umap|png|jpe?g|gif|webp|zip|gz|7z|pdf|woff2?|ttf))$/i;
const textExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hpp",
  ".inl",
  ".cs",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".mts",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".md",
  ".mdx",
  ".txt",
  ".json",
  ".jsonc",
  ".toml",
  ".yaml",
  ".yml",
  ".ini",
  ".cfg",
  ".xml",
  ".html",
  ".css",
  ".scss",
  ".sql",
  ".uproject",
  ".uplugin",
]);

function extension(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const index = base.lastIndexOf(".");
  return index < 0 ? "" : base.slice(index).toLowerCase();
}

function glob(pattern: string): RegExp {
  let result = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        result += ".*";
        index += 1;
      } else result += "[^/]*";
    } else if (character === "?") result += "[^/]";
    else result += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${result}$`);
}

function denied(path: string): boolean {
  const segments = path.split("/");
  return (
    segments.some((segment) => deniedSegments.has(segment)) ||
    deniedNames.some((pattern) => pattern.test(segments.at(-1) ?? "")) ||
    qualityExcluded.test(path)
  );
}

function redact(content: string): string {
  return content
    .replace(
      /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{16,}\b/g,
      "[REDACTED TOKEN]",
    )
    .replace(
      /((?:password|secret|token|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    );
}

function encodeSegment(segment: string): string {
  return segment.replace(
    /[%#?]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

function encodedPath(path: string): string {
  return path.split("/").map(encodeSegment).join("/");
}

export interface IndexScanResult {
  rows: StagedRow[];
  paths: string[];
  fileCount: number;
  totalBytes: number;
  skipped: Record<string, number>;
  contentHash: string;
}

export async function scanIndex(input: {
  source: IndexSource;
  project: ProjectConfig;
  limits: {
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    deadlineSeconds: number;
  };
  signal?: AbortSignal;
}): Promise<IndexScanResult> {
  const include = input.project.index.include.map(glob);
  const exclude = input.project.index.exclude.map(glob);
  const rows: StagedRow[] = [];
  const paths: string[] = [];
  const skipped: Record<string, number> = {};
  let totalBytes = 0;
  const deadline = performance.now() + input.limits.deadlineSeconds * 1_000;
  const entries = await input.source.list();
  for (const entry of entries) {
    if (input.signal?.aborted) throw new Error("indexing cancelled");
    if (performance.now() >= deadline)
      throw new Error("indexing deadline exceeded");
    const reason = denied(entry.path)
      ? "denied"
      : include.length > 0 &&
          !include.some((pattern) => pattern.test(entry.path))
        ? "not-included"
        : exclude.some((pattern) => pattern.test(entry.path))
          ? "excluded"
          : !textExtensions.has(extension(entry.path))
            ? "unsupported"
            : null;
    if (reason) {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
      continue;
    }
    if (paths.length >= input.limits.maxFiles)
      throw new Error("index file-count limit exceeded");
    const read = await input.source.read(entry.path, input.limits.maxFileBytes);
    if (read.overLimit) {
      skipped.oversized = (skipped.oversized ?? 0) + 1;
      continue;
    }
    if (read.bytes.includes(0)) {
      skipped.binary = (skipped.binary ?? 0) + 1;
      continue;
    }
    totalBytes += read.bytes.length;
    if (totalBytes > input.limits.maxTotalBytes)
      throw new Error("index byte limit exceeded");
    const content = redact(read.bytes.toString("utf8"));
    rows.push({
      kind: "node",
      uri: buildEntityUri({
        kind: "file",
        projectKey: input.project.key,
        repositoryKey: input.project.repositoryKey,
        path: encodedPath(entry.path),
      }),
      type: "file",
      label: entry.path,
      content,
    });
    paths.push(entry.path);
  }
  rows.sort((left, right) => {
    const leftKey =
      left.kind === "node"
        ? left.uri
        : `${left.from}\0${left.type}\0${left.to}`;
    const rightKey =
      right.kind === "node"
        ? right.uri
        : `${right.from}\0${right.type}\0${right.to}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const canonical = rows
    .map((row) =>
      JSON.stringify(Object.fromEntries(Object.entries(row).sort())),
    )
    .join("\n");
  return {
    rows,
    paths,
    fileCount: paths.length,
    totalBytes,
    skipped,
    contentHash: createHash("sha256").update(canonical).digest("hex"),
  };
}
