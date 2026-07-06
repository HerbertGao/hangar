import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pino, { type Logger } from 'pino';
import type { DB } from './db.js';
import { EVENT } from './events.js';
import { lockOwner } from './lock.js';
import type { Action, Gateway } from './executor.js';
import { appendEvent, chokePoint, EngineError } from './store.js';

/**
 * The context a tool handler receives. Deliberately tiny: a handler executes one
 * named action and must be reconstructible from `{tool,args}` alone (approve may
 * run in a different process than run()), so the only extra it gets is an
 * idempotency key for the high-risk approve path.
 */
export interface HandlerContext {
  runId: string;
  logger: Logger;
  /**
   * Approval.id for the high-risk approve path — the at-most-once claim key the
   * gateway passes through so a handler/external system can dedupe. Undefined for
   * low-risk immediate execution (no Approval row exists).
   */
  idempotencyKey?: string;
}

/** A single named action's execution body, living in `apps/<id>/tools.ts`. */
export type Handler = (args: object, ctx: HandlerContext) => Promise<unknown>;

/** The by-name handler registry an app exports from `tools.ts`. */
export type Handlers = Record<string, Handler>;

/** In-memory bounded retry cap for transient handler failures. NOT durable. */
const MAX_ATTEMPTS = 3;

const now = (): string => new Date().toISOString();

/**
 * Strip obvious secrets before an error text is written to an event or a log.
 * Generic only — the spine knows no domain, so there is NO domain-specific regex
 * here (no email/inbox patterns). Covers bearer tokens, secret-ish key=value
 * pairs, JWTs, and long hex/base64 blobs.
 */
export function redactError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/\bbearer\s+[\w.\-+/=]+/gi, 'bearer [REDACTED]')
    .replace(
      /([\w-]*(?:password|passwd|pwd|secret|token|api[-_]?key|apikey|access[-_]?key|auth(?:orization)?)[\w-]*)(\s*["']?\s*[:=]\s*["']?\s*)([^\s"',;}]+)/gi,
      '$1$2[REDACTED]',
    )
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[REDACTED_JWT]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[REDACTED_HEX]')
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '[REDACTED_B64]');
}

interface ApprovalRow {
  id: string;
  tool: string;
  args_json: string;
}

/**
 * The tool gateway: the only place approval policy and action execution live.
 * Constructed per app (it needs the app's dir to load `tools.ts` and its
 * high-risk tool list). The run engine calls `propose`/`evaluateAfterRun`; the
 * CLI calls `approve`/`reject` — possibly in a later, separate process, which is
 * why the handler registry loads independently of run()'s closure.
 *
 * Phase 0 assumes a single approving process. The run-state guard + run-lock
 * claim + reaper + idempotency key cover crash recovery and "second approver is
 * blocked by the guard"; full multi-process arbitration is deferred to Phase 1.
 */
export class PipelineGateway implements Gateway {
  private handlersPromise?: Promise<Handlers>;
  private readonly logger: Logger;

  constructor(
    private readonly db: DB,
    /** Absolute path to apps/<id>/. */
    private readonly appDir: string,
    /** spec.permissions.approval — tools that PARK instead of executing inline. */
    private readonly approvalTools: readonly string[],
    logger?: Logger,
  ) {
    this.logger =
      logger ??
      pino({ level: process.env.LOG_LEVEL ?? 'info' }, pino.destination(2)).child({
        gateway: true,
      });
  }

  private loadHandlers(): Promise<Handlers> {
    // ponytail: dynamic import is ESM-cached per URL; temp app dirs are unique so
    // no cross-instance collision. Memoized per gateway.
    return (this.handlersPromise ??= (async () => {
      const url = pathToFileURL(join(this.appDir, 'tools.ts')).href;
      const mod = (await import(url)) as { tools?: Handlers; default?: Handlers };
      const handlers = mod.tools ?? mod.default;
      if (!handlers || typeof handlers !== 'object') {
        throw new EngineError(
          'tool_handler_missing',
          `${this.appDir}/tools.ts must export a tools registry ({ [tool]: (args, ctx) => Promise })`,
        );
      }
      return handlers;
    })());
  }

  private async handlerFor(tool: string): Promise<Handler> {
    const handlers = await this.loadHandlers();
    const h = handlers[tool];
    if (typeof h !== 'function') {
      throw new EngineError('tool_handler_missing', `no handler for tool '${tool}' in ${this.appDir}/tools.ts`);
    }
    return h;
  }

  /** Run a handler with in-memory bounded retry. Throws the last error on exhaustion. */
  private async execute(
    runId: string,
    tool: string,
    args: object,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const handler = await this.handlerFor(tool);
    const ctx: HandlerContext = {
      runId,
      logger: this.logger.child({ run: runId, tool }),
      idempotencyKey,
    };
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await handler(args, ctx);
      } catch (err) {
        lastErr = err;
        // ponytail: no backoff — immediate bounded retry; add jitter/delay if a
        // real transient source (rate limit, flaky net) ever needs pacing.
        ctx.logger.warn({ attempt, error: redactError(err) }, 'action attempt failed');
      }
    }
    throw lastErr;
  }

  /**
   * Single async action entry. Low-risk → execute inline (retry), emit
   * action.executed, resolve the handler result. High-risk → register an
   * Approval(pending), resolve void; do NOT execute, throw, or interrupt run().
   */
  async propose(runId: string, action: Action): Promise<unknown> {
    const args = action.args ?? {};
    if (this.approvalTools.includes(action.tool)) {
      this.db
        .prepare(
          `INSERT INTO Approval (id,run_id,tool,args_json,status,requested_at) VALUES (?,?,?,?, 'pending', ?)`,
        )
        .run(`ap_${randomUUID()}`, runId, action.tool, JSON.stringify(args), now());
      return undefined; // parked — resolve void, run() keeps going
    }

    try {
      const result = await this.execute(runId, action.tool, args);
      appendEvent(this.db, runId, EVENT.actionExecuted, { tool: action.tool });
      return result;
    } catch (err) {
      // action.failed is NON-terminal (the run does not die here). Throw the
      // already-redacted error back to run(): if it propagates, runApp records
      // it into run.failed — so redact before throwing to keep that path clean.
      const redacted = redactError(err);
      appendEvent(this.db, runId, EVENT.actionFailed, { tool: action.tool, error: redacted });
      throw new Error(redacted);
    }
  }

  /**
   * check-after-return: called once after run() returns normally. Pending
   * Approvals → emit approval.requested for each (→ waiting_human, a non-terminal
   * park, so NOT via chokePoint). None → the run completes through the choke-point.
   */
  async evaluateAfterRun(runId: string): Promise<void> {
    const pending = this.pendingApprovals(runId);
    if (pending.length === 0) {
      chokePoint(this.db, runId, EVENT.runCompleted, {});
      return;
    }
    for (const ap of pending) {
      appendEvent(this.db, runId, EVENT.approvalRequested, {
        approvalId: ap.id,
        tool: ap.tool,
        args: JSON.parse(ap.args_json),
      });
    }
  }

  /**
   * Grant a parked run. Guards state==waiting_human and atomically claims the run
   * lock (→executing, lock_owner=self) so the second stage is a single writer and
   * a crash is reaper-reclaimable. Executes each pending handler (Approval.id as
   * idempotency key), then completes — or, on an exhausted failure, fails via the
   * choke-point without rolling back already-granted actions.
   */
  async approve(runId: string): Promise<void> {
    const owner = lockOwner();
    // Guard + claim + pending snapshot + approval.granted, atomically. A thrown
    // guard error rolls the whole thing back, leaving the run in waiting_human.
    const claim = this.db.transaction((): ApprovalRow[] => {
      const res = this.db
        .prepare(`UPDATE Run SET state='executing', lock_owner=? WHERE id=? AND state='waiting_human'`)
        .run(owner, runId);
      if (res.changes === 0) throw new EngineError('not_waiting', `run ${runId} is not waiting_human`);
      const pending = this.pendingApprovals(runId);
      if (pending.length === 0) {
        throw new EngineError('no_pending_approval', `run ${runId} has no pending approval`);
      }
      appendEvent(this.db, runId, EVENT.approvalGranted, {});
      return pending;
    });
    const pending = claim();

    for (const ap of pending) {
      // at-most-once claim of this approval (CAS); a lost claim → skip.
      const claimed = this.db
        .prepare(`UPDATE Approval SET status='granting' WHERE id=? AND status='pending'`)
        .run(ap.id);
      if (claimed.changes === 0) continue;

      const args = JSON.parse(ap.args_json) as object;
      try {
        await this.execute(runId, ap.tool, args, ap.id);
      } catch (err) {
        const redacted = redactError(err);
        this.db.transaction(() => {
          appendEvent(this.db, runId, EVENT.actionFailed, {
            tool: ap.tool,
            approvalId: ap.id,
            error: redacted,
          });
          this.db
            .prepare(`UPDATE Approval SET status='failed', decided_at=?, decided_by=? WHERE id=?`)
            .run(now(), owner, ap.id);
        })();
        // choke-point → run.failed; already-granted approvals are kept, remaining
        // pending/granting are superseded by chokePoint. Stop here.
        chokePoint(this.db, runId, EVENT.runFailed, { tool: ap.tool, error: redacted });
        return;
      }

      this.db.transaction(() => {
        appendEvent(this.db, runId, EVENT.actionExecuted, { tool: ap.tool, approvalId: ap.id });
        this.db
          .prepare(`UPDATE Approval SET status='granted', decided_at=?, decided_by=? WHERE id=?`)
          .run(now(), owner, ap.id);
      })();
    }

    chokePoint(this.db, runId, EVENT.runCompleted, {});
  }

  /**
   * Reject a parked run. Same guard + lock claim, then runs NO handler: pending
   * Approvals → rejected, and the run is cancelled through the choke-point.
   */
  async reject(runId: string, reason?: string): Promise<void> {
    const owner = lockOwner();
    this.db.transaction(() => {
      const res = this.db
        .prepare(`UPDATE Run SET state='executing', lock_owner=? WHERE id=? AND state='waiting_human'`)
        .run(owner, runId);
      if (res.changes === 0) throw new EngineError('not_waiting', `run ${runId} is not waiting_human`);
      this.db
        .prepare(`UPDATE Approval SET status='rejected', decided_at=?, decided_by=? WHERE run_id=? AND status='pending'`)
        .run(now(), owner, runId);
      chokePoint(this.db, runId, EVENT.runCancelled, reason ? { reason: redactError(reason) } : {});
    })();
  }

  private pendingApprovals(runId: string): ApprovalRow[] {
    // ORDER BY rowid = insertion order = proposal order (Approval's PK is TEXT, so
    // rowid is a separate monotonic column). requested_at ties within a run;
    // proposal order must be preserved so an N-action app executes in sequence.
    return this.db
      .prepare(
        `SELECT id, tool, args_json FROM Approval WHERE run_id=? AND status='pending' ORDER BY rowid`,
      )
      .all(runId) as ApprovalRow[];
  }
}
