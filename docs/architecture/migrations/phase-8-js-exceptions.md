# Remaining JavaScript exceptions

Owner for all entries: shiloh-plugin maintainers. Inventory date: 2026-10-14.

Shipped business implementation is TypeScript. JavaScript entries load generated ESM or assemble host capabilities. Engineering programs below do not implement the production request path; they remain standalone build, evaluation and diagnostic tools. Tests, examples and user-provided extensions remain separately classified. Generated JavaScript in dist is excluded from source debt.

376 compatibility entries are individually recorded with emitted implementation, reviewed composition SHA256 or AST-validated pure exports in [phase-8-metrics.json](phase-8-metrics.json).

## Host bootstraps

| Entry | Reason |
| --- | --- |
| `guoba.support.js` | Guoba metadata and configuration assembly |
| `index.js` | Host module loader and runtime assembly |
| `standalone/bl-dice-plugin/apps/dice.js` | Standalone host compatibility re-export |
| `standalone/bl-dice-plugin/apps/diceLog.js` | Standalone host compatibility re-export |
| `standalone/bl-dice-plugin/guoba.support.js` | Guoba metadata and configuration assembly |
| `standalone/bl-dice-plugin/index.js` | Host module loader and runtime assembly |
| `standalone/bl-emoji-plugin/apps/EmojiPackImport.js` | Standalone host compatibility re-export |
| `standalone/bl-emoji-plugin/index.js` | Host module loader and runtime assembly |
| `standalone/bl-games-plugin/apps/DeltaForcePlugin.js` | Standalone host compatibility re-export |
| `standalone/bl-games-plugin/apps/UmaRacePlugin.js` | Standalone host compatibility re-export |
| `standalone/bl-games-plugin/index.js` | Host module loader and runtime assembly |
| `standalone/bl-group-admin-plugin/apps/GroupGuardDecrease.js` | Standalone host compatibility re-export |
| `standalone/bl-group-admin-plugin/apps/GroupGuardIncrease.js` | Standalone host compatibility re-export |
| `standalone/bl-group-admin-plugin/apps/GroupGuardMessage.js` | Standalone host compatibility re-export |
| `standalone/bl-group-admin-plugin/apps/GroupModerationMessage.js` | Standalone host compatibility re-export |
| `standalone/bl-group-admin-plugin/apps/GroupNoticeDecrease.js` | Standalone host compatibility re-export |
| `standalone/bl-group-admin-plugin/apps/GroupNoticeIncrease.js` | Standalone host compatibility re-export |
| `standalone/bl-group-admin-plugin/index.js` | Host module loader and runtime assembly |
| `standalone/bl-knowledge-plugin/apps/knowledge.js` | Standalone host compatibility re-export |
| `standalone/bl-knowledge-plugin/index.js` | Host module loader and runtime assembly |
| `standalone/bl-media-plugin/apps/BilibiliRelay.js` | Standalone host compatibility re-export |
| `standalone/bl-media-plugin/apps/MagnetSearchPlugin.js` | Standalone host compatibility re-export |
| `standalone/bl-media-plugin/index.js` | Host module loader and runtime assembly |
| `standalone/bl-memory-plugin/apps/MemoryCommands.js` | Standalone host compatibility re-export |
| `standalone/bl-memory-plugin/index.js` | Host module loader and runtime assembly |

## Engineering JavaScript programs

| File | Purpose |
| --- | --- |
| `scripts/backend-build.mjs` | Backend compiler and artifact manifest verification |
| `scripts/backend-test.mjs` | Test discovery, compilation and runner |
| `scripts/check-boundaries.mjs` | Architecture import boundary verification |
| `scripts/coc-command-sim.mjs` | Dice command scenario verification |
| `scripts/evaluateEmojiSelectionAgainstCatalog.js` | Offline/opt-in emoji selection evaluation |
| `scripts/gen-commands-doc.mjs` | Command reference document generator |
| `scripts/lib/build-support.mjs` | Build and release integrity helpers |
| `scripts/mem-embedding-check.mjs` | Opt-in embedding/fixture integration diagnostic |
| `scripts/mem-intel-live-check.mjs` | Opt-in memory intelligence fixture diagnostic |
| `scripts/mem-live-check.mjs` | Opt-in live memory fixture diagnostic |
| `scripts/mem-p0-check.mjs` | Opt-in memory contract fixture diagnostic |
| `scripts/migration-report.mjs` | Immutable baseline and migration inventory audit |
| `scripts/personaReplay.mjs` | Persona scenario replay evaluation |
| `scripts/release.mjs` | Release packaging, install journal and rollback |
| `scripts/semantic-memory-eval.mjs` | Semantic recall evaluation harness |
| `scripts/shadow-e2e.mjs` | Shadow scenario integration harness |
| `scripts/simulateEmojiConversationScenarios.js` | Emoji conversation scenario evaluation |
| `scripts/simulateImageTaskScenarios.js` | Image task scenario evaluation |
| `scripts/simulateThreeImageSuites.js` | Image suite scenario evaluation |

The memory diagnostics can call optional external Redis/model services when explicitly executed; they are not executed by the default phase gate or this release acceptance. Their environment-dependent integration outcomes are not claimed by unit-test results.

## Explicitly retired modules

The six Xiaohongshu files and the obsolete one-time runtime memory schema replacement script are documented in [phase-8.md](phase-8.md). The fixed baseline is unchanged; retired code is not counted as migrated code.
