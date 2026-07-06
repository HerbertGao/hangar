/**
 * The fixed v0 lifecycle event kinds and the state derivation over them.
 *
 * The spine knows no domain concepts: domain detail rides in RunEvent.payload_json,
 * never in the kind column. `classify` is a full map — only `run.*` are terminal;
 * `action.*` are per-action progress (a run may execute many actions, one failing
 * is not the run failing). App-emitted domain kinds (anything not in STATE_BY_KIND)
 * are non-terminal and do not move the lifecycle state.
 */

export type State =
  | 'queued'
  | 'running'
  | 'waiting_human'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const EVENT = {
  runStarted: 'run.started',
  approvalRequested: 'approval.requested',
  approvalGranted: 'approval.granted',
  actionExecuted: 'action.executed',
  actionFailed: 'action.failed',
  runCompleted: 'run.completed',
  runFailed: 'run.failed',
  runCancelled: 'run.cancelled',
} as const;

/** Terminal event kinds — the only ones allowed through the choke-point. */
export const TERMINAL_KINDS: ReadonlySet<string> = new Set([
  EVENT.runCompleted,
  EVENT.runFailed,
  EVENT.runCancelled,
]);

export function isTerminalKind(kind: string): boolean {
  return TERMINAL_KINDS.has(kind);
}

/**
 * Single source of truth for kind → state. Terminal kinds are included so
 * `classify` is a full map, but only `run.*` are terminal states; `action.*`
 * and `approval.granted` are the non-terminal `executing` progress.
 */
export const STATE_BY_KIND: Record<string, State> = {
  [EVENT.runStarted]: 'running',
  [EVENT.approvalRequested]: 'waiting_human',
  [EVENT.approvalGranted]: 'executing',
  [EVENT.actionExecuted]: 'executing',
  [EVENT.actionFailed]: 'executing',
  [EVENT.runCompleted]: 'completed',
  [EVENT.runFailed]: 'failed',
  [EVENT.runCancelled]: 'cancelled',
};

export interface EventLike {
  seq: number;
  kind: string;
}

/**
 * Derive a run's state from its events (ordered by seq ascending). Uses the most
 * recent *lifecycle* event, stepping over app-emitted domain kinds so they never
 * regress or terminate a run. No lifecycle event → 'queued'. Total, never throws.
 */
export function classify(events: readonly EventLike[]): State {
  for (let i = events.length - 1; i >= 0; i--) {
    const s = STATE_BY_KIND[events[i].kind];
    if (s !== undefined) return s;
  }
  return 'queued';
}
