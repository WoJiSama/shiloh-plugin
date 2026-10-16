import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {execFileSync} from 'node:child_process'

const root = '/opt/trss-yunzai/plugins/shiloh-plugin'
const expected = process.argv[2]
const replay = process.argv[3]
const configSnapshot = process.argv[4]
if (!expected || !replay || !configSnapshot) throw new Error('Provide expected release, frozen replay runtime and pre-deployment config hash snapshot paths')
const read = (base, name) => fs.readFileSync(path.join(base, name))
const hash = buffer => createHash('sha256').update(buffer).digest('hex')
const json = (base, name) => JSON.parse(read(base, name))
const expectedConfigs = JSON.parse(fs.readFileSync(configSnapshot, 'utf8'))
if (Object.keys(expectedConfigs).sort().join(',') !== 'config/message.yaml,config/persona-library.yaml'
  || Object.values(expectedConfigs).some(digest => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))) {
  throw new Error('Config snapshot must contain exactly the two protected configuration file hashes')
}
const manifest = json(root, 'release-manifest.json')
const expectedManifest = json(expected, 'release-manifest.json')
const replayManifest = json(replay, 'release-manifest.json')
const mismatches = (base, files) => Object.entries(files).flatMap(([name, digest]) => {
  try { return hash(read(base, name)) === digest ? [] : [name] } catch { return [name] }
})
const backendFiles = files => Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith('dist/backend/') && name.endsWith('.js')))
const backend = json(root, 'dist/backend/manifest.json')
const replayBackend = json(replay, 'dist/backend/manifest.json')
const require = createRequire(path.join(root, 'package.json'))
const raw = require('js-yaml').load(read(root, 'config/message.yaml').toString())
const config = raw.pluginSettings || raw
const shell = (command, args) => {
  try { return execFileSync(command, args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}).trim() }
  catch (error) { throw new Error(`Audit command failed: ${command}; code=${error.code ?? error.status ?? 'unknown'}`) }
}
const services = Object.fromEntries(['trss-yunzai', 'bl-console'].map(name => [name, {
  state: shell('systemctl', ['is-active', name]),
  restartCount: shell('systemctl', ['show', '-p', 'NRestarts', '--value', name]),
  activeSince: shell('systemctl', ['show', '-p', 'ActiveEnterTimestamp', '--value', name])
}]))
const journal = shell('journalctl', ['-u', 'trss-yunzai', '--since', services['trss-yunzai'].activeSince, '--no-pager',
  '--grep', '载入插件错误|ReferenceError|SyntaxError|is not defined|unhandled|MessagePipeline.*已启动'])
const sameObject = (first, second) => JSON.stringify(Object.entries(first).sort()) === JSON.stringify(Object.entries(second).sort())
const result = {
  at: new Date().toISOString(), deployedCommit: manifest.commit, expectedCommit: expectedManifest.commit,
  managedFileCount: Object.keys(manifest.files).length,
  managedMismatches: mismatches(root, manifest.files),
  expectedReleaseMismatches: mismatches(root, expectedManifest.files),
  backendJsCount: Object.keys(backendFiles(expectedManifest.files)).length,
  sameBackendManifest: hash(read(root, 'dist/backend/manifest.json')) === hash(read(expected, 'dist/backend/manifest.json')),
  replayCommit: replayManifest.commit,
  replayRuntimeMismatches: mismatches(root, backendFiles(replayManifest.files)),
  sameReplayBackendSources: sameObject(backend.sources, replayBackend.sources),
  sameReplayBackendFiles: sameObject(backend.files, replayBackend.files),
  configHashes: Object.fromEntries(['config/message.yaml', 'config/persona-library.yaml'].map(name => [name, hash(read(root, name))])),
  expectedConfigHashes: expectedConfigs,
  configSnapshotHash: hash(fs.readFileSync(configSnapshot)),
  reasoning: {global: config.chatAiConfig?.chatReasoningEffort, complex: config.chatAiConfig?.complexReasoningEffort,
    casual: config.taskAiConfig?.casual?.reasoningEffort, tools: config.toolsAiConfig?.toolsReasoningEffort ?? '', useTools: config.useTools},
  services,
  loadErrors: journal.split('\n').filter(line => /载入插件错误|ReferenceError|SyntaxError|is not defined|unhandled/.test(line)).length,
  pipelineStarted: journal.split('\n').filter(line => /MessagePipeline.*已启动/.test(line)).length,
  pages: Object.fromEntries([['commands', 'http://127.0.0.1:2536/bl-chat/commands'], ['console', 'http://127.0.0.1:8787/']].map(([name, url]) =>
    [name, shell('curl', ['-s', '-o', '/dev/null', '-m', '5', '-w', '%{http_code}', url])]))
}
console.log(JSON.stringify(result, null, 2))
if (manifest.commit !== expectedManifest.commit || result.managedMismatches.length || result.expectedReleaseMismatches.length || !result.sameBackendManifest ||
    result.replayRuntimeMismatches.length || !result.sameReplayBackendSources || !result.sameReplayBackendFiles ||
    result.loadErrors || !result.pipelineStarted || Object.values(result.pages).some(code => code !== '200') ||
    Object.values(services).some(service => service.state !== 'active' || service.restartCount !== '0') ||
    Object.entries(expectedConfigs).some(([name, digest]) => result.configHashes[name] !== digest) ||
    result.reasoning.global !== 'low' || result.reasoning.complex !== 'low' || result.reasoning.casual !== 'low' ||
    !['', 'low'].includes(result.reasoning.tools) || result.reasoning.useTools !== true) process.exitCode = 1
