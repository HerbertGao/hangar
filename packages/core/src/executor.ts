import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pino, { type Logger } from 'pino';
import type { DB } from './db.js';
import { EVENT } from './events.js';
import { appendEvent, chokePoint, createRun, EngineError } from './store.js';

export interface Action {
  tool: string;
  args: object;
}

/**
 * The app-facing run context. There is deliberately NO direct tool entry: every
 * side effect goes through `propose`, so the OS (tool gateway) decides park vs
 * immediate execution against `permissions.approval` — an app can't bypass approval.
 */
export interface RunContext {
  input: unknown;
  config: Record<string, unknown>;
  logger: Logger;
  emit(kind: string, payload?: object): void;
  propose(action: Action): Promise<unknown>;
}

/** The pluggable execution seam. v0's only implementation is PipelineExecutor. */
export interface Executor {
  run(ctx: RunContext): Promise<void>;
}

/**
 * The tool-gateway contract, implemented by the gateway group (C2). The run engine
 * only calls these; it does not implement propose/approve/reject/evaluateAfterRun.
 */
export interface Gateway {
  propose(runId: string, action: Action): Promise<unknown>;
  evaluateAfterRun(runId: string): Promise<void>;
  approve(runId: string): Promise<void>;
  reject(runId: string, reason?: string): Promise<void>;
}

/** v0's only Executor: import `apps/<id>/pipeline.ts` and call its `run(ctx)`. */
export class PipelineExecutor implements Executor {
  constructor(private readonly appDir: string) {}
  async run(ctx: RunContext): Promise<void> {
    const url = pathToFileURL(join(this.appDir, 'pipeline.ts')).href;
    const mod = (await import(url)) as { run?: (ctx: RunContext) => Promise<void> };
    if (typeof mod.run !== 'function') {
      throw new EngineError('pipeline_invalid', `${this.appDir}/pipeline.ts has no exported run()`);
    }
    await mod.run(ctx);
  }
}

export interface RunRequest {
  appId: string;
  /** Absolute path to apps/<appId>/. */
  appDir: string;
  /** spec.executor — only 'pipeline' is implemented in v0. */
  executor: string;
  config?: Record<string, unknown>;
  input?: unknown;
  /** Trigger label recorded on the Run (default 'manual'). */
  trigger?: string;
}

/**
 * Drive one run end to end. Pre-flight (executor kind, pipeline.ts existence) runs
 * BEFORE createRun, so a bad app never takes the lock. A thrown pipeline error →
 * `run.failed` via the choke-point. A normal return → gateway.evaluateAfterRun,
 * which decides PARK (waiting_human) vs completion — check-after-return, never via
 * throw. Returns the run id (even on failure, so the caller can trace it).
 */
export async function runApp(db: DB, req: RunRequest, gateway: Gateway): Promise<string> {
  if (req.executor !== 'pipeline') {
    throw new EngineError('executor_unsupported', `executor '${req.executor}' is not implemented`);
  }
  if (!existsSync(join(req.appDir, 'pipeline.ts'))) {
    throw new EngineError('pipeline_missing', `${req.appDir}/pipeline.ts not found`);
  }

  const executor = new PipelineExecutor(req.appDir);
  const runId = createRun(db, req.appId, req.trigger ?? 'manual');
  const logger = pino(
    { level: process.env.LOG_LEVEL ?? 'info' },
    pino.destination(2),
  ).child({ run: runId, app: req.appId });

  const ctx: RunContext = {
    input: req.input,
    config: req.config ?? {},
    logger,
    emit: (kind, payload) => {
      appendEvent(db, runId, kind, payload ?? {});
    },
    propose: (action) => gateway.propose(runId, action),
  };

  try {
    await executor.run(ctx);
  } catch (err) {
    chokePoint(db, runId, EVENT.runFailed, {
      error: String((err as Error)?.message ?? err),
    });
    return runId;
  }
  await gateway.evaluateAfterRun(runId);
  return runId;
}
