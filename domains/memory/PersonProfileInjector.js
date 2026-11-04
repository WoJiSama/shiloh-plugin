import { pluginBridge } from '../../utils/pluginBridge.js'
import { createPersonProfileClass } from '../../dist/backend/modules/memory/application/personProfileInjector.js'
import { lazyRedis } from '../../utils/simulationRuntime.js'

// 跨群人物档案与仿真系统共用同一份 Redis 存储（键 shiloh:sim:person:{qq}，形状见 simulation/infrastructure/simSessionStore.ts）。
// 主链路只读不写：写入路径仍是仿真侧的提取器 + simRemember 双轨协同。
async function readCrossGroupProfile(userId) {
  try {
    const id = String(userId || '').replace(/[^0-9]/g, '')
    if (!id) return null
    const raw = await lazyRedis().get(`shiloh:sim:person:${id}`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const list = value => (Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean).slice(0, 12) : [])
    const profile = { interests: list(parsed.interests), taboos: list(parsed.taboos) }
    if (typeof parsed.name === 'string' && parsed.name.trim()) profile.name = parsed.name.trim().slice(0, 20)
    if (list(parsed.traits).length) profile.traits = list(parsed.traits)
    if (list(parsed.facts).length) profile.facts = list(parsed.facts)
    return (profile.name || profile.interests.length || profile.taboos.length || profile.traits?.length || profile.facts?.length) ? profile : null
  } catch {
    return null
  }
}

export const PersonProfileInjector = createPersonProfileClass({
  getConfig: () => pluginBridge.instance?.config || {},
  getPersonaFor: event => pluginBridge.instance?.getPersonaFor?.(event) || null,
  getMessages: (type, groupId) => pluginBridge.sharedState?.messageManager?.getMessages?.(type, groupId) || Promise.resolve([]),
  getCrossGroupProfile: readCrossGroupProfile,
})
export const personProfileInjector = new PersonProfileInjector()
