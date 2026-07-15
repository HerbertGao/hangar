import { pathToFileURL } from 'node:url';
import pino, { type Logger } from 'pino';
import type { DB } from './db.js';
import { EVENT } from './events.js';
import { resolvePipelineEntry } from './registry.js';
import { appendEvent, chokePoint, createRun, EngineError } from './store.js';
import { createRuntimeCapabilities } from './capabilities.js';

export interface Action {
  tool: string;
  args: object;
}

/**
 * The app-facing run context. `propose` is the entry for approval-eligible actions:
 * the OS (tool gateway) decides park vs immediate execution against
 * `permissions.approval`. Per the DESIGN §3.5 carve-out an app MAY perform its own
 * inherently-safe domain side-effects directly in `run()`; only approvable/high-risk
 * actions MUST route through `propose`. So #5 is app-authoring discipline on the
 * direct path, not a structural guarantee.
 */
export interface RunContext {
  input: unknown;
  /** Host-generated, `--trigger`/app-unforgeable trigger category. Written only at the
   * two run-creation entries (cmdRun → 'manual', daemon cron → 'cron'). See DESIGN §3.5. */
  triggerKind: 'manual' | 'cron';
  /** Optional trigger identity (the trigger's opaque `name`); spine zero-domain (#1),
   * app switches on it internally. Single unnamed trigger → undefined → default path. */
  triggerName?: string;
  /** @deprecated 用 triggerName. Kept (= triggerName) so pilots that only read
   * ctx.trigger stay backward compatible (old spine / unnamed trigger → undefined). */
  trigger?: string;
  config: Record<string, unknown>;
  logger: Logger;
  emit(kind: string, payload?: object): void;
  propose(action: Action): Promise<unknown>;
  /** Read-only cancellation signal. Always provided; observing it is optional — a
   * pipeline MAY watch it to wind down gracefully, but ignoring it must still run
   * (backward compatible). Aborting maps to `run.cancelled` via the choke-point (see
   * runApp). */
  readonly signal: AbortSignal;
  /** Fresh, frozen snapshot of the host's canonical capability set. The host creates
   * this value for every run; app input/config/trigger metadata cannot replace it. */
  readonly capabilities: readonly string[];
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

/** v0's only Executor: import the app's resolved entry (dist/pipeline.js | pipeline.ts) and call its `run(ctx)`. */
export class PipelineExecutor implements Executor {
  constructor(private readonly appDir: string) {}
  async run(ctx: RunContext): Promise<void> {
    const entry = resolvePipelineEntry(this.appDir);
    if (entry === null) {
      throw new EngineError('pipeline_missing', `${this.appDir}: no dist/pipeline.js or pipeline.ts`);
    }
    const mod = (await import(pathToFileURL(entry).href)) as {
      run?: (ctx: RunContext) => Promise<void>;
    };
    if (typeof mod.run !== 'function') {
      throw new EngineError('pipeline_invalid', `${entry} has no exported run()`);
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
  /** Host-generated trigger category; written only at the two run-creation entries
   * (cmdRun → 'manual', daemon cron → 'cron'). Unforgeable by --trigger flag / pilot. */
  triggerKind: 'manual' | 'cron';
  /** Named trigger identity → ctx.trigger/triggerName + Run.trigger (name takes priority). */
  triggerName?: string;
}

/**
 * Drive one run end to end. Pre-flight (executor kind, pipeline entry existence:
 * dist/pipeline.js | pipeline.ts) runs BEFORE createRun, so a bad app never takes
 * the lock. A thrown pipeline error → `run.failed` (or `run.cancelled` when
 * ctx.signal is aborted) via the choke-point. A normal return → gateway.evaluateAfterRun,
 * which decides PARK (waiting_human) vs completion — check-after-return, never via
 * throw. Returns the run id (even on failure, so the caller can trace it).
 */
export async function runApp(
  db: DB,
  req: RunRequest,
  gateway: Gateway,
  opts?: { onActive?(runId: string, abort: () => void): void },
): Promise<string> {
  if (req.executor !== 'pipeline') {
    throw new EngineError('executor_unsupported', `executor '${req.executor}' is not implemented`);
  }
  if (resolvePipelineEntry(req.appDir) === null) {
    throw new EngineError('pipeline_missing', `${req.appDir}: no dist/pipeline.js or pipeline.ts`);
  }

  const executor = new PipelineExecutor(req.appDir);
  const controller = new AbortController();
  // Run.trigger stores the trigger name when present (trace attribution), else falls
  // back to the category — so this column now carries BOTH names (digest/poll) and
  // categories (cron/manual); consumers MUST NOT assume trigger ∈ {cron, manual}.
  const runId = createRun(db, req.appId, req.triggerName ?? req.triggerKind);
  // Hand the abort handle to the caller synchronously. MUST be no `await` between
  // createRun and here: else a just-created run isn't yet in the daemon's active Map
  // when an abort-all shutdown scan runs, and it would escape cancellation.
  opts?.onActive?.(runId, () => controller.abort());
  const logger = pino(
    { level: process.env.LOG_LEVEL ?? 'info' },
    pino.destination(2),
  ).child({ run: runId, app: req.appId });

  const ctx: RunContext = {
    input: req.input,
    triggerKind: req.triggerKind,
    triggerName: req.triggerName,
    trigger: req.triggerName,
    config: req.config ?? {},
    logger,
    emit: (kind, payload) => {
      appendEvent(db, runId, kind, payload ?? {});
    },
    propose: (action) => gateway.propose(runId, action),
    signal: controller.signal,
    capabilities: createRuntimeCapabilities(),
  };

  try {
    await executor.run(ctx);
  } catch (err) {
    // Aborted → cancelled, else failed. Same payload either way: keep the raw error
    // text so a real fault during shutdown isn't silently recorded as a clean cancel.
    chokePoint(db, runId, ctx.signal.aborted ? EVENT.runCancelled : EVENT.runFailed, {
      error: String((err as Error)?.message ?? err),
    });
    return runId;
  }
  // A normal return after an abort must record cancelled, not slip through
  // evaluateAfterRun (which would record completed).
  if (ctx.signal.aborted) {
    chokePoint(db, runId, EVENT.runCancelled);
    return runId;
  }
  await gateway.evaluateAfterRun(runId);
  return runId;
}
