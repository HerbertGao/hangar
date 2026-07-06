import type { RunContext } from '@hangar/core';

/**
 * The Phase-0 toy pipeline: emit one neutral progress event, then propose the
 * same high-risk action twice. Both are in permissions.approval, so each PARKs
 * (registers Approval(pending), resolves void, does NOT interrupt run()) — proving
 * one run can accrue N pending approvals → one waiting_human. Zero domain concepts.
 */
export async function run(ctx: RunContext): Promise<void> {
  ctx.emit('progress', { step: 'tick', proposed: 2 });
  await ctx.propose({ tool: 'demo.risky', args: { beat: 1 } });
  await ctx.propose({ tool: 'demo.risky', args: { beat: 2 } });
}
