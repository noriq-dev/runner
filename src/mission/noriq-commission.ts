import { createHash } from 'node:crypto';
import type { MissionLeaseRef, MissionRootCommission, Run } from '@noriq-dev/shared';
import type { MissionExecutionProfileMatch } from './execution-profile-registry';
import type { LocalMissionRuntime } from './local-runtime';
import {
  MAX_NORIQ_TASK_BRIEF_CHARS,
  type NoriqMissionCommission,
  type NoriqMissionTaskSnapshot,
  computeNoriqMissionCommissionDigest,
  validateNoriqMissionCommission,
} from './noriq-coordinator-store';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundedBrief(parts: readonly string[], taskId: string): string {
  const brief = parts.filter(Boolean).join('\n\n');
  if (brief.length === 0 || brief.length > MAX_NORIQ_TASK_BRIEF_CHARS || brief.includes('\0')) {
    throw new Error(
      `commissioned task '${taskId}' cannot be represented within the ${MAX_NORIQ_TASK_BRIEF_CHARS}-character mission objective bound`,
    );
  }
  return brief;
}

function taskBrief(task: object, plan: { title: string; body: string; revision: string } | null): string {
  const value = task as {
    taskId: string;
    key: string;
    title: string;
    body: string;
    priority: number;
    type: string;
    estimate: number | null;
    dueAt: string | null;
    workflow: string | null;
    executionSpec: unknown;
    phaseTitle?: string;
    phaseOrder?: number;
    taskOrder?: number;
  };
  const metadata = JSON.stringify({
    key: value.key,
    priority: value.priority,
    type: value.type,
    estimate: value.estimate,
    dueAt: value.dueAt,
    workflow: value.workflow,
    executionSpec: value.executionSpec,
    ...(value.phaseTitle === undefined
      ? {}
      : { phase: value.phaseTitle, phaseOrder: value.phaseOrder, taskOrder: value.taskOrder }),
  });
  return boundedBrief(
    [
      plan ? `Plan: ${plan.title}\nPlan revision: ${plan.revision}\n\n${plan.body}` : '',
      `Task ${value.key}: ${value.title}`,
      value.body,
      `Commissioned task metadata: ${metadata}`,
    ],
    value.taskId,
  );
}

function topologicalTasks(tasks: readonly NoriqMissionTaskSnapshot[]): readonly NoriqMissionTaskSnapshot[] {
  const remaining = new Map(tasks.map((task) => [task.taskId, task]));
  const emitted = new Set<string>();
  const ordered: NoriqMissionTaskSnapshot[] = [];
  while (remaining.size > 0) {
    const ready = tasks.find(
      (task) => remaining.has(task.taskId) && task.dependencyIds.every((id) => emitted.has(id)),
    );
    if (!ready) throw new Error('commissioned task graph is cyclic or references an absent task');
    ordered.push(ready);
    emitted.add(ready.taskId);
    remaining.delete(ready.taskId);
  }
  return ordered;
}

function narrowBudget(run: Run, profile: MissionExecutionProfileMatch<LocalMissionRuntime>) {
  const ceiling = profile.declaration.missionBudget;
  if (ceiling.tokens === null || ceiling.activeSeconds === null) {
    throw new Error('mission execution profile lacks mandatory token or active-time ceilings');
  }
  return {
    tokens: Math.min(run.budget.maxTokens ?? ceiling.tokens, ceiling.tokens),
    usd: ceiling.usd === null ? run.budget.maxUsd : Math.min(run.budget.maxUsd ?? ceiling.usd, ceiling.usd),
    activeSeconds: Math.min(run.budget.maxDurationSeconds ?? ceiling.activeSeconds, ceiling.activeSeconds),
  };
}

/** Convert the server snapshot plus locally pinned machine/VCS authority into one durable root. */
export function noriqMissionCommissionFromAssignment(input: {
  run: Run;
  lease: MissionLeaseRef;
  serverCommission: MissionRootCommission;
  repositoryKey: string;
  baseRevision: string;
  profile: MissionExecutionProfileMatch<LocalMissionRuntime>;
}): NoriqMissionCommission {
  const { run, lease, serverCommission, repositoryKey, baseRevision, profile } = input;
  if (!run.executionProfile) throw new Error('mission assignment lacks a commissioned execution profile');
  if (serverCommission.snapshot.runId !== run.id)
    throw new Error('mission commission names a different root run');
  if (serverCommission.snapshot.sitting !== lease.sitting)
    throw new Error('mission commission sitting does not match its lease');
  const observedServerDigest = sha256(JSON.stringify(serverCommission.snapshot));
  if (observedServerDigest !== serverCommission.digest) {
    throw new Error('mission commission digest does not match the immutable Noriq snapshot');
  }

  let tasks: readonly NoriqMissionTaskSnapshot[];
  let publishHandoff: boolean;
  const snapshot = serverCommission.snapshot;
  if ('planId' in snapshot) {
    const dependencies = new Map<string, string[]>();
    const known = new Set(snapshot.tasks.map((task) => task.taskId));
    for (const edge of snapshot.dependencies) {
      if (!known.has(edge.taskId) || !known.has(edge.dependsOnTaskId)) {
        throw new Error('mission commission dependency escapes the immutable task snapshot');
      }
      const values = dependencies.get(edge.taskId) ?? [];
      if (values.includes(edge.dependsOnTaskId))
        throw new Error('mission commission repeats a dependency edge');
      values.push(edge.dependsOnTaskId);
      dependencies.set(edge.taskId, values);
    }
    tasks = topologicalTasks(
      snapshot.tasks.map((task, index) => ({
        taskId: task.taskId,
        childKey: task.key,
        brief: taskBrief(task, {
          title: snapshot.planTitle,
          // The plan body is root context, not a tax paid again by every worker prompt.
          body: index === 0 ? snapshot.planBody : '',
          revision: snapshot.planRevision,
        }),
        // Noriq's begin gate treats every task in an earlier phase as a blocker even when the
        // explicit dependency table omits that edge. Mirror that authority locally so a
        // topological reorder can never ask Noriq to begin a later phase first.
        dependencyIds: [
          ...new Set([
            ...snapshot.tasks
              .filter((candidate) => candidate.phaseOrder < task.phaseOrder)
              .map((candidate) => candidate.taskId),
            ...(dependencies.get(task.taskId) ?? []),
          ]),
        ],
      })),
    );
    publishHandoff = true;
  } else {
    const task = snapshot.task;
    tasks = [{ taskId: task.taskId, childKey: task.key, brief: taskBrief(task, null), dependencyIds: [] }];
    publishHandoff = false;
  }

  const body: Omit<NoriqMissionCommission, 'commissionDigest'> = {
    schemaVersion: 1,
    rootRunId: run.id,
    lease,
    serverCommissionDigest: serverCommission.digest,
    publishHandoff,
    executionProfile: run.executionProfile,
    repositoryKey,
    baseRevision,
    tasks,
    budget: narrowBudget(run, profile),
    catalogFingerprint: profile.runtime.catalog.fingerprint,
    resources: profile.runtime.resources,
  };
  return validateNoriqMissionCommission({
    ...body,
    commissionDigest: computeNoriqMissionCommissionDigest(body),
  });
}
