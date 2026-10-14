// Structural checks inspect real authored sources behind registered compatibility entries.
// Behavioral tests should import emitted modules instead.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {migrations} from '../../scripts/migration-report.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const mapping=new Map(migrations.map(item=>[item.legacy,item]))
export function readSource(relPath) {
 const item=mapping.get(relPath)
 const paths=[relPath,...(item?[item.implementation,...(item.additionalImplementations||[])]:[])]
 return paths.map(file=>fs.readFileSync(path.join(root,file),'utf8')).join('\n')
}
export function readPluginSources() {
 const parts=[readSource('apps/test.js')]
 for(const file of fs.readdirSync(path.join(root,'apps/lib')).filter(f=>f.endsWith('.js')))parts.push(readSource('apps/lib/'+file))
 return parts.join('\n')
}
export const pluginRoot=root
