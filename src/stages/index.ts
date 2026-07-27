/**
 * The run pipeline's stages (RUN-131). `src/run-machine.ts` declares the SEQUENCE as data; these
 * are the bodies it runs. One module per stage, so a new one (RUN-140/141/144) is a new file plus a
 * descriptor rather than another branch in the middle of the supervisor.
 */

export { verifyStage } from './verify';
export { reviewStage } from './review';
export { integrateStage } from './integrate';
export { settleStage } from './settle';
export type { RunPipeline, StageHost, StageImpl } from './types';
