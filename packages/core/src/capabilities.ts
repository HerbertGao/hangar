/**
 * Versioned host capability strings, each `hangar.run.<name>/vN` (immutable id, N =
 * capability semantic version). Broadcast verbatim by `doctor --json`'s `capabilities[]`
 * (the real host binary's set). A member MUST NOT appear here unless the same build truly
 * provides its runtime contract — bumping semantics MUST mint a new `/vN`, never reuse.
 */
export const HOST_CAPABILITIES: readonly string[] = Object.freeze([
  'hangar.run.trigger-kind/v1',
  'hangar.run.abort-signal/v1',
  'hangar.run.cancelled-terminal/v1',
  'hangar.run.runtime-capabilities/v1',
]);

/** Create the app-facing view from the one canonical set. Every run receives a new
 * frozen array, so app mutation attempts cannot affect another run or doctor output. */
export function createRuntimeCapabilities(): readonly string[] {
  return Object.freeze([...HOST_CAPABILITIES]);
}

/**
 * Fail-closed assertion primitive: exact `name/vN` string match, `required ⊆ have`; throws
 * if any required string is absent. No version ordering — an unknown newer `.../v2` does NOT
 * satisfy a required `.../v1`. `have` is MANDATORY with no module-local default: a default
 * could validate a caller's bundled `@hangar/core` copy instead of the running host and pass
 * falsely. Deployment callers pass the real host's `doctor --json` set; pipelines pass the
 * host-injected `ctx.capabilities` snapshot at the start of `run(ctx)`.
 */
export function assertCapabilities(required: readonly string[], have: readonly string[]): void {
  const missing = required.filter((cap) => !have.includes(cap));
  if (missing.length > 0) {
    throw new Error(`missing host capabilities: ${missing.join(', ')}`);
  }
}
