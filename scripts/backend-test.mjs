import fs from 'node:fs/promises'
import path from 'node:path'
import { root, run, filesUnder } from './lib/build-support.mjs'

run(process.execPath, ['scripts/backend-build.mjs'])
await fs.rm(path.join(root, '.test-build'), { recursive: true, force: true })
run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.backend-tests.json'])
const legacy = (await filesUnder(path.join(root, 'tests'))).filter(file => file.endsWith('.test.js'))
const typed = (await filesUnder(path.join(root, '.test-build/tests/typescript'))).filter(file => file.endsWith('.test.js'))
if (!typed.length || !legacy.length) throw new Error('Both legacy and TypeScript tests must be discovered')
console.log(`Discovered ${legacy.length} legacy JS test files + ${typed.length} compiled TS test files`)
const concurrency = Number(process.env.BACKEND_TEST_CONCURRENCY || 4)
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('BACKEND_TEST_CONCURRENCY must be an integer between 1 and 32')
run(process.execPath, ['--test', `--test-concurrency=${concurrency}`, ...legacy, ...typed])
