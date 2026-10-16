import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'

const [runtime, reference, frozen, production = '/opt/trss-yunzai/plugins/shiloh-plugin'] = process.argv.slice(2)
if (!runtime || !reference || !frozen) throw new Error('Provide final runtime, reference runtime and frozen configuration root')
const require = createRequire(path.join(runtime, 'package.json'))
const yaml = require('yaml')
const read = (root, name) => fs.readFileSync(path.join(root, name))
const sha = value => createHash('sha256').update(value).digest('hex')
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
const hashValue = value => sha(JSON.stringify(stable(value)))
const roots = ['groupModeration.overlongMessage', 'groupModeration.burstMessage', 'groupModeration.adScan', 'emojiSystem.admissionExtraReject', 'groupAdmin']
const withoutNonChatRoots = input => {
  const value = structuredClone(input)
  for (const name of roots) {
    const keys = name.split('.'), leaf = keys.pop()
    const parent = keys.reduce((object, key) => object?.[key], value)
    if (parent) delete parent[leaf]
  }
  return value
}
const differingPaths = (first, second, prefix = '') => {
  if (hashValue(first ?? null) === hashValue(second ?? null)) return []
  if (first && second && typeof first === 'object' && typeof second === 'object' && !Array.isArray(first) && !Array.isArray(second)) {
    return [...new Set([...Object.keys(first), ...Object.keys(second)])].flatMap(key => differingPaths(first[key], second[key], prefix ? `${prefix}.${key}` : key))
  }
  return [prefix]
}
const allowed = name => roots.some(root => name === root || name.startsWith(`${root}.`))
const effective = async (base, configRoot) => {
  const load = name => import(pathToFileURL(path.join(base, 'dist/backend', name)).href)
  const {mergeDeepConfig} = await load('modules/config/infrastructure/configStore.js')
  const {decodeHostConfig} = await load('modules/host/infrastructure/hostConfig.js')
  const {createPersonaLibrary} = await load('modules/conversation/infrastructure/personaLibrary.js')
  const document = (root, name) => {const value = yaml.parse(read(root, name).toString()); return value?.pluginSettings || value || {}}
  const config = decodeHostConfig(mergeDeepConfig(document(base, 'config_default/message.yaml'), document(configRoot, 'config/message.yaml')))
  config.persona = createPersonaLibrary({libraryPath:path.join(configRoot, 'config/persona-library.yaml'), getBasePersona:()=>config.persona})
    .resolve({messageType:'group', groupId:'609235590', selfId:'3094088525'}).persona
  return config
}
const finalConfig = await effective(runtime, frozen)
const referenceConfig = await effective(reference, frozen)
const liveConfig = await effective(runtime, production)
const comparison = (first, second) => ({
  firstHash:hashValue(first), secondHash:hashValue(second), differingPaths:differingPaths(first, second),
  firstRelevantHash:hashValue(withoutNonChatRoots(first)), secondRelevantHash:hashValue(withoutNonChatRoots(second)),
  relevantEqual:hashValue(withoutNonChatRoots(first)) === hashValue(withoutNonChatRoots(second))
})
const result = {
  at:new Date().toISOString(), method:'Full effective configuration hashes retained; only the explicitly listed non-chat roots are removed for the separate applicability comparison. No configuration values are exported.',
  allowedNonChatRoots:roots,
  finalCommit:JSON.parse(read(runtime, 'release-manifest.json')).commit,
  referenceCommit:JSON.parse(read(reference, 'release-manifest.json')).commit,
  frozenConfigHash:sha(read(frozen, 'config/message.yaml')),
  frozenPersonaLibraryHash:sha(read(frozen, 'config/persona-library.yaml')),
  runtimeComparison:comparison(referenceConfig, finalConfig),
  productionComparison:comparison(finalConfig, liveConfig),
  productionConfigHashes:Object.fromEntries(['config/message.yaml', 'config/persona-library.yaml'].map(name => [name, sha(read(production, name))]))
}
console.log(JSON.stringify(result, null, 2))
for (const value of [result.runtimeComparison, result.productionComparison]) {
  assert.ok(value.relevantEqual, 'Chat-relevant effective configuration changed')
  assert.ok(value.differingPaths.every(allowed), 'Configuration changed outside the declared non-chat roots')
}
assert.equal(result.frozenPersonaLibraryHash, result.productionConfigHashes['config/persona-library.yaml'])
