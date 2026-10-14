import { runBilibiliBackfillCli } from '../dist/backend/scripts/backfillBilibiliRecords.js'
await runBilibiliBackfillCli(process.argv.slice(2))
