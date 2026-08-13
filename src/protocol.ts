import { z } from "zod";
import {
  jobAssignmentSchema,
  runnerJobEventPayloadSchema,
} from "./contracts.js";

const id = z.string().trim().min(1).max(128);
export const repositoryHelloSchema = z
  .object({
    repositoryKey: id,
    repoRef: z.string().min(1).max(500),
    baseRevision: z.string().regex(/^[0-9a-f]{40,64}$/),
  })
  .strict();

export const runnerToServerSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hello"),
      protocolVersion: z.literal(2),
      runnerId: id,
      capacity: z.number().int().positive().max(32),
      repositories: z.array(repositoryHelloSchema).max(1_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("heartbeat"),
      freeSlots: z.number().int().nonnegative().max(32),
      activeJobIds: z.array(id).max(32),
    })
    .strict(),
  z
    .object({ type: z.literal("job.accept"), jobId: id, assignmentId: id })
    .strict(),
  z
    .object({
      type: z.literal("job.event"),
      jobId: id,
      assignmentId: id,
      seq: z.number().int().positive(),
      payload: runnerJobEventPayloadSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("job.reconcile"),
      jobId: id,
      assignmentId: id,
      lastLocalSeq: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type RunnerToServer = z.infer<typeof runnerToServerSchema>;

export const serverToRunnerSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("job.assign"), assignment: jobAssignmentSchema })
    .strict(),
  z
    .object({
      type: z.literal("job.cancel"),
      jobId: id,
      assignmentId: id,
      reason: z.string().max(4_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("job.answer"),
      jobId: id,
      assignmentId: id,
      questionId: id,
      answer: z.string().max(20_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("job.event.ack"),
      jobId: id,
      assignmentId: id,
      seq: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("job.reconcile.result"),
      jobId: id,
      assignmentId: id,
      action: z.enum(["continue", "cancel"]),
    })
    .strict(),
]);
export type ServerToRunner = z.infer<typeof serverToRunnerSchema>;
