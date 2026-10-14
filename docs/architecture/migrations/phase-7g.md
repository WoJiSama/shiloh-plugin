# Phase 7G: host lifecycle and administrative entries

Migrated chat host lifecycle, shared services, configuration decoding, message archive commands, command help, thinking-forward command entry, QQ lookup, administrative commands, observability and bootstrap verification to strict TypeScript. JS entries now compose injected host dependencies or re-export compiled modules; their reviewed hashes are registered.

## Validation

`BACKEND_TEST_CONCURRENCY=2 TZ=UTC npm run verify:phase` passed. Backend: 1855 tests, 1844 passed, 11 conditional skips, zero failures. Frontend: 34 passed. Strict source and test typechecking, source boundaries, compilation, compiled compatibility loading, release installation/rollback tests and frontend build passed. New focused compiled tests: 30 passed. No paid model calls or actual QQ sends were performed.

## Contracts and behavior

Host events retain receiver binding and event identity; private events do not receive fabricated group IDs. Session factories preserve typed business state across tool refreshes. Configuration and model response boundaries reject malformed known fields. Group notice cache separates bot identities. Archive forwarding requires confirmed receipts and stops on unknown delivery. Guoba authentication fails closed without a signing secret. Final replies preserve bot identity in persisted recent messages. Memory extraction accepts both synchronous queued results and asynchronous results.

## Inventory and rollback

Business JS: 12 files, 7406 token-bearing lines; business TS: 452 files, 81488 token-bearing lines. JS business line share: 8.3313%. Registered compatibility JS: 365 files. Newly discovered unregistered business JS: zero. Full inventory is in phase-7g-metrics.json. Remaining scope is console server/web applications and six unused Xiaohongshu files; these remain counted as business debt.

This stage is an independent commit; revert it as a unit and rebuild artifacts to roll back. Production deployment remains pending the remaining migration stages and final release checks. Existing conditional browser skips and earlier-stage limitations remain applicable.
