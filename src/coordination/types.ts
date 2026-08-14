import type {
  RunnerCoordinationAcquireResult,
  RunnerCoordinationLease,
  RunnerCoordinationLeaseIdentity,
  RunnerCoordinationLeaseKind,
  RunnerCoordinationLeaseScope,
} from "@noriq-dev/shared";

export type LeaseKind = RunnerCoordinationLeaseKind;

export type LeaseScope = RunnerCoordinationLeaseScope;

export type LeaseIdentity = RunnerCoordinationLeaseIdentity;

export type CoordinationLease = RunnerCoordinationLease;

export type AcquireResult = RunnerCoordinationAcquireResult;

export interface CoordinationProvider {
  acquire(
    input: LeaseIdentity &
      LeaseScope & { ttlSeconds: number; previousFencingToken?: number },
  ): Promise<AcquireResult>;
  exchange(input: {
    lease: CoordinationLease;
    scope: LeaseScope;
    ttlSeconds: number;
  }): Promise<AcquireResult>;
  renew(
    lease: CoordinationLease,
    ttlSeconds: number,
  ): Promise<CoordinationLease>;
  recover(lease: CoordinationLease, ttlSeconds: number): Promise<AcquireResult>;
  release(lease: CoordinationLease): Promise<void>;
}
