import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Handlers } from '@hangar/core';

// ponytail: marker defaults to this app dir; HANGAR_HEARTBEAT_MARKER lets the DoD
// point it at a temp file. Path resolves relative to tools.ts, not cwd.
const MARKER =
  process.env.HANGAR_HEARTBEAT_MARKER ??
  fileURLToPath(new URL('.heartbeat-marker', import.meta.url));

/**
 * The by-name handler registry the gateway loads independently of run(). The
 * high-risk handler's OBSERVABLE side effect (one appended line, tagged with the
 * idempotency key = Approval.id) is what the DoD asserts after approve — proof
 * that execute actually ran, not just that core emitted action.executed.
 */
export const tools: Handlers = {
  'demo.risky': async (args, ctx) => {
    const line = `${new Date().toISOString()} run=${ctx.runId} key=${ctx.idempotencyKey ?? 'none'} args=${JSON.stringify(args)}\n`;
    appendFileSync(MARKER, line);
    return { marker: MARKER };
  },
};
