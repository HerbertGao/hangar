# V2 CLI cutover pointer

The V2 CLI facade is `apps/hangar-cli/index.ts` and depends only on the generated Control SDK.

Legacy contract pointer: the pre-V2 CLI/process surface remains represented by the archived V0/M0 contracts and `packages/core/dist/cli.*`; it is not invoked by the V2 facade.

Deletion conditions for legacy CLI artifacts:

1. M2 CLI, Web, and Telegram acceptance is complete through the public Control API.
2. Candidate and production qualification are separately approved (both remain false during M2).
3. No active release, rollback plan, or archived evidence references the legacy subprocess entrypoint.
4. A dedicated removal change records compatibility impact and rollback evidence.
