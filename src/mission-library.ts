/**
 * Published mission-harness surface.
 *
 * The daemon's historical `src/index.ts` exports the whole Runner implementation, including the
 * bundled parser grammars. Publishing that graph again beside the self-contained CLI would nearly
 * double the package for an API whose consumers need only the mission harness and generic MCP
 * preparation boundary. Keep this entry deliberately narrow; daemon routing remains a separate
 * integration concern.
 */
export * from './project-mcp';
export * from './process-containment';
export * from './agent-homes';
export { GitBackend, type GitOps, type LockDelegate } from './vcs/git';
export { WorktreeManager, type WorktreeInfo, type GitRunner } from './worktree';
export * from './mission/index';
