import {
  RunnerCoordinationAcquireResult,
  RunnerCoordinationLease,
} from "@noriq-dev/shared";
import { z } from "zod";
import type { NoriqHttpClient } from "../noriq/http.js";
import type {
  AcquireResult,
  CoordinationLease,
  CoordinationProvider,
  LeaseIdentity,
  LeaseScope,
} from "./types.js";

export class NoriqCoordinationProvider implements CoordinationProvider {
  constructor(private readonly http: NoriqHttpClient) {}

  acquire(
    input: LeaseIdentity &
      LeaseScope & { ttlSeconds: number; previousFencingToken?: number },
  ): Promise<AcquireResult> {
    return this.post("acquire", input, RunnerCoordinationAcquireResult);
  }

  exchange(input: {
    lease: CoordinationLease;
    scope: LeaseScope;
    ttlSeconds: number;
  }): Promise<AcquireResult> {
    return this.post("exchange", input, RunnerCoordinationAcquireResult);
  }

  async renew(
    lease: CoordinationLease,
    ttlSeconds: number,
  ): Promise<CoordinationLease> {
    return this.post(
      "renew",
      { leaseId: lease.leaseId, fencingToken: lease.fencingToken, ttlSeconds },
      RunnerCoordinationLease,
    );
  }

  recover(
    lease: CoordinationLease,
    ttlSeconds: number,
  ): Promise<AcquireResult> {
    return this.post(
      "recover",
      { ...lease, ttlSeconds },
      RunnerCoordinationAcquireResult,
    );
  }

  async release(lease: CoordinationLease): Promise<void> {
    await this.post(
      "release",
      { leaseId: lease.leaseId, fencingToken: lease.fencingToken },
      z.object({ ok: z.literal(true) }),
    );
  }

  private async post<T>(
    operation: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const value = await this.http.json<unknown>(
      `/api/runner-coordination/${operation}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return schema.parse(value);
  }
}
