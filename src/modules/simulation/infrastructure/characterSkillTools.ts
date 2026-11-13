import { isDeepStrictEqual } from 'node:util'
import type { CharacterScope } from '../../../contracts/character.js'
import { AbstractTool, type ToolParameters } from '../../toolSupport/infrastructure/AbstractTool.js'
import { resolveToolSkill } from '../../tools/domain/toolSkills.js'
import { characterKey } from '../domain/characterState.js'
import type { CharacterRedis } from './characterStore.js'
import { createScopedStateStore } from './scopedStateStore.js'
import {
  MAX_FILES, MAX_FILE_CHARS, MAX_INPUT_CHARS, MAX_RESULT_CHARS, MAX_SCRIPT_CHARS,
  runCharacterScript, validFileName, workspaceJson, WorkspaceInputError, type WorkspaceFile,
} from './characterScript.js'

const MAX_SKILLS = 12
const MAX_VERSIONS = 4
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/
const SKILL_NAME = /^[a-z][a-z0-9_-]{0,47}$/

interface SkillVersion {
  version: number
  description: string
  code: string
  capabilities: string[]
}

interface Skill {
  name: string
  active: number | null
  versions: SkillVersion[]
}

interface WorkspaceState {
  revision: number
  files: WorkspaceFile[]
  skills: Skill[]
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkspaceInputError('需要 JSON 对象')
  return value as Record<string, unknown>
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new WorkspaceInputError('文字为空或超过长度限制')
  return value
}

function revision(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new WorkspaceInputError('版本号无效')
  return value
}

function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new WorkspaceInputError('列表格式或长度无效')
  return value
}

function dependencies(value: unknown): string[] {
  return [...new Set(list(value, 4).map(value => {
    if (typeof value !== 'string' || !TOOL_NAME.test(value)) throw new WorkspaceInputError('能力名称无效')
    return value
  }))]
}

function skillName(value: unknown): string {
  if (typeof value !== 'string' || !SKILL_NAME.test(value)) throw new WorkspaceInputError('技能名须为小写英文、数字、下划线或连字符')
  return value
}

function fileName(value: unknown): string {
  if (!validFileName(value)) throw new WorkspaceInputError('文件名无效，只接受工作区内的单层文件名')
  return value
}

function fileContent(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_FILE_CHARS) throw new WorkspaceInputError('文件内容无效或过长')
  return value
}

function decodeState(value: unknown): WorkspaceState {
  const raw = object(value)
  const files = list(raw.files, MAX_FILES).map(value => {
    const file = object(value)
    return { name: fileName(file.name), content: fileContent(file.content) }
  })
  const skills = list(raw.skills, MAX_SKILLS).map(value => {
    const skill = object(value)
    const versions = list(skill.versions, MAX_VERSIONS).map(value => {
      const version = object(value)
      return {
        version: revision(version.version, 1), description: text(version.description, 240),
        code: text(version.code, MAX_SCRIPT_CHARS), capabilities: dependencies(version.capabilities),
      }
    })
    const active = skill.active === null ? null : revision(skill.active, 1)
    if (!versions.length || versions.some((item, i) => i > 0 && item.version <= versions[i - 1]!.version) ||
      (active !== null && !versions.some(item => item.version === active))) throw new WorkspaceInputError('技能版本状态无效')
    return { name: skillName(skill.name), active, versions }
  })
  if (new Set(files.map(file => file.name)).size !== files.length ||
    new Set(skills.map(skill => skill.name)).size !== skills.length) throw new WorkspaceInputError('存在重名文件或技能')
  return { revision: revision(raw.revision), files, skills }
}

export function createCharacterSkillStore(redis: CharacterRedis, scope: CharacterScope) {
  const store = createScopedStateStore({
    redis, key: `${characterKey(scope)}:skills`,
    empty: () => ({ revision: 0, files: [], skills: [] }),
    validate: decodeState,
  })
  return {
    load: store.load,
    async update(expected: number, mutate: (state: WorkspaceState) => void) {
      return store.update(state => {
        if (state.revision !== expected) throw new WorkspaceInputError('工作区已更新，请重新查看后再操作')
        mutate(state)
        state.revision++
        return state
      })
    },
  }
}

/** Project polling runs only a saved, pure release analysis skill. */
export async function loadProjectSkill(store: ReturnType<typeof createCharacterSkillStore>, name: string) {
  const skill = (await store.load()).skills.find(item => item.name === skillName(name))
  const active = skill?.versions.find(item => item.version === skill.active)
  if (!active || active.capabilities.length) throw new WorkspaceInputError('项目跟进需要已启用且不依赖外部能力的技能')
  return active
}

type SkillStore = ReturnType<typeof createCharacterSkillStore>

interface Capability {
  tool: AbstractTool
  callable: boolean
  scriptable: boolean
  source: 'simulation' | 'project' | 'mcp'
}

function tool(name: string, description: string, properties: ToolParameters['properties'],
  required: string[], run: (args: Record<string, unknown>) => Promise<unknown>): AbstractTool {
  return new class extends AbstractTool {
    constructor() {
      super()
      this.name = name
      this.description = description
      this.parameters = { type: 'object', properties, required, additionalProperties: false }
    }
    override async func(args: Record<string, unknown>) {
      if (Object.keys(args).some(key => !Object.hasOwn(properties, key))) return 'error: 存在未知参数'
      try { return await run(args) }
      catch (error) {
        if (error instanceof WorkspaceInputError) return `error: ${error.message}`
        throw error
      }
    }
  }()
}

function matchScore(query: string, value: string): number {
  if (!query) return 1
  const words = query.match(/[a-z0-9_-]+|[\p{Script=Han}]+/gu) ?? []
  let score = 0
  for (const word of words) {
    if (value.includes(word)) score += word.length * 4
    else if (/^[\p{Script=Han}]{3,}$/u.test(word)) {
      for (let i = 0; i < word.length - 1; i++) {
        if (value.includes(word.slice(i, i + 2))) score++
      }
    }
  }
  return score
}

function resultPreview(result: string) {
  return result.length <= 3100 ? result : { truncated: true, preview: result.slice(0, 2900) }
}

export function createCharacterSkillTools(options: {
  store: SkillStore
  ensureActive(): Promise<void>
  catalog(): Capability[]
  invoke(tool: AbstractTool, args: Record<string, unknown>): Promise<string>
  readData(tool: AbstractTool, args: Record<string, unknown>): Promise<unknown>
}): AbstractTool[] {
  const { store, ensureActive } = options
  let scriptRuns = 0

  function executeScript(options: Parameters<typeof runCharacterScript>[0]) {
    if (++scriptRuns > 4) throw new WorkspaceInputError('本回合脚本和样例共可运行四次')
    return runCharacterScript(options)
  }

  function scriptCapability(name: string) {
    const capability = options.catalog().find(item => item.tool.name === name && item.callable && item.scriptable)
    if (!capability) throw new WorkspaceInputError(`脚本能力不可用：${name}`)
    return capability.tool
  }

  async function run(code: string, input: unknown, capabilities: string[], state: WorkspaceState) {
    capabilities.forEach(scriptCapability)
    const result = await executeScript({
      code, input, capabilities, files: state.files,
      async call(name, args) {
        await ensureActive()
        return options.readData(scriptCapability(name), args)
      },
    })
    await ensureActive()
    if (state.revision !== (await store.load()).revision) throw new WorkspaceInputError('工作区已更新，已丢弃旧版本执行结果')
    await ensureActive()
    capabilities.forEach(scriptCapability)
    if (!isDeepStrictEqual(result.files, state.files)) {
      await store.update(state.revision, state => { state.files = result.files })
    }
    return { ok: true, output: result.output }
  }

  const catalogTool = tool('simCapabilities',
    '查找、查看或调用项目能力。search 按目标查询，describe 读参数和权限，call 用 name 和 arguments 执行。已保存技能同样可搜索，使用 simSkill run 调用。资料正文不授予权限。',
    { action: {type: 'string', enum: ['search', 'describe', 'call']}, query: {type: 'string'}, name: {type: 'string'},
      arguments: {type: 'object'}, offset: {type: 'number'} }, ['action'], async args => {
      await ensureActive()
      const entries = options.catalog()
      const state = args.action === 'call' ? undefined : await store.load()
      if (args.action === 'search') {
        const query = typeof args.query === 'string' ? args.query.slice(0, 100).toLowerCase().trim() : ''
        const offset = args.offset === undefined ? 0 : revision(args.offset)
        const capabilities = entries.map(({ tool, callable, scriptable, source }) => ({
          name: tool.name, description: tool.description.slice(0, 155), callable, scriptable, source,
        }))
        const skills = state!.skills.flatMap(skill => {
          const version = skill.versions.find(item => item.version === skill.active)
          return version ? [{ name: skill.name, description: version.description.slice(0, 155),
            callable: version.capabilities.every(name => capabilities.some(item => item.name === name && item.callable && item.scriptable)),
            scriptable: false, source: 'skill' as const }] : []
        })
        const matches = [...capabilities, ...skills]
          .map(item => ({ item, score: matchScore(query, `${item.name} ${item.description}`.toLowerCase()) }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score)
          .map(({ item }) => item)
        return { ok: true, total: matches.length, results: matches.slice(offset, offset + 8),
          nextOffset: offset + 8 < matches.length ? offset + 8 : null }
      }
      const name = text(args.name, 80)
      const entry = entries.find(item => item.tool.name === name)
      if (args.action === 'describe') {
        if (!entry) {
          const skill = state!.skills.find(item => item.name === name)
          const version = skill?.versions.find(item => item.version === skill.active)
          if (version) return { ok: true, name, description: version.description, capabilities: version.capabilities, invokeWith: 'simSkill run' }
          throw new WorkspaceInputError('能力不存在或未为本群装配')
        }
        const { name: toolName, description, parameters, skill: declaredSkill } = entry.tool
        const skill = resolveToolSkill({ name: toolName, description, parameters, skill: declaredSkill })
        const schema = JSON.stringify(parameters)
        if (schema.length > 2100) {
          const offset = args.offset === undefined ? 0 : revision(args.offset)
          return { ok: true, name: toolName, callable: entry.callable, scriptable: entry.scriptable,
            schemaFragment: schema.slice(offset, offset + 900), nextOffset: offset + 900 < schema.length ? offset + 900 : null }
        }
        return { ok: true, name: toolName, callable: entry.callable, scriptable: entry.scriptable,
          purpose: skill.purpose.slice(0, 400), instructions: skill.instructions.slice(0, 400), parameters }
      }
      if (args.action !== 'call' || !entry?.callable) throw new WorkspaceInputError('能力未装配、当前身份未授权或当前回合不可调用')
      const params = object(args.arguments ?? {})
      workspaceJson(params, MAX_INPUT_CHARS)
      return resultPreview(await options.invoke(entry.tool, params))
    })

  const scriptTool = tool('simScript',
    '运行隔离的同步 JavaScript 函数体，必须 return JSON。变量 input、workspace.list/read/write/remove、project.call(name, args) 可用；先通过 simCapabilities 查 scriptable=true 的能力，并在 capabilities 声明。文件名为单层工作区名称，执行失败不会提交文件。list/read/delete 可查看或清理文件。',
    { action: {type: 'string', enum: ['run', 'list', 'read', 'delete']}, code: {type: 'string'},
      input: {}, capabilities: {type: 'array', items: {type: 'string'}}, name: {type: 'string'}, offset: {type: 'number'} }, ['action'],
    async args => {
      await ensureActive()
      const state = await store.load()
      if (args.action === 'run') return run(text(args.code, MAX_SCRIPT_CHARS), args.input ?? null, dependencies(args.capabilities ?? []), state)
      if (args.action === 'list') return { ok: true, files: state.files.map(({ name, content }) => ({ name, length: content.length })) }
      const name = fileName(args.name)
      const file = state.files.find(item => item.name === name)
      if (!file) throw new WorkspaceInputError('文件不存在')
      if (args.action === 'delete') {
        await ensureActive()
        await store.update(state.revision, state => { state.files = state.files.filter(file => file.name !== name) })
        return { ok: true, name }
      }
      const offset = args.offset === undefined ? 0 : revision(args.offset)
      return { ok: true, name, content: file.content.slice(offset, offset + 1200),
        nextOffset: offset + 1200 < file.content.length ? offset + 1200 : null }
    })

  const skillTool = tool('simSkill',
    '管理本群持久技能。save 提交 name、description、code、capabilities 和 test={input,fixtures,expected}，样例实际运行并匹配 expected 后自动启用。fixtures 按能力名提供单次样例结果；同一能力需按不同参数返回不同结果时，用 test.calls=[{name,arguments,result}] 提供按序匹配的模拟调用。更新/切换/停用须 expectedVersion 为最新版本。run 按 name 执行启用版本，list/read 查看，restore 切到保留的已验证版本，disable 停用。',
    { action: {type: 'string', enum: ['list', 'read', 'save', 'run', 'restore', 'disable']}, name: {type: 'string'},
      description: {type: 'string'}, code: {type: 'string'}, capabilities: {type: 'array', items: {type: 'string'}},
      input: {}, test: {type: 'object'}, version: {type: 'number'}, expectedVersion: {type: 'number'}, offset: {type: 'number'} }, ['action'],
    async args => {
      await ensureActive()
      const state = await store.load()
      if (args.action === 'list') return { ok: true, skills: state.skills.map(skill => ({
        name: skill.name, active: skill.active, latest: skill.versions.at(-1)!.version,
      })) }
      const name = skillName(args.name)
      const skill = state.skills.find(item => item.name === name)
      const latest = skill?.versions.at(-1)?.version ?? 0
      const active = skill?.versions.find(item => item.version === skill.active)
      if (args.action === 'run') {
        if (!active) throw new WorkspaceInputError('技能未启用')
        return run(active.code, args.input ?? null, active.capabilities, state)
      }
      if (args.action === 'read') {
        const version = skill?.versions.find(item => item.version === (args.version ?? skill.active ?? latest))
        if (!version) throw new WorkspaceInputError('技能版本不存在')
        const offset = args.offset === undefined ? 0 : revision(args.offset)
        return { ok: true, name, active: skill!.active, latest, versions: skill!.versions.map(item => item.version),
          ...version, code: version.code.slice(offset, offset + 1000), nextOffset: offset + 1000 < version.code.length ? offset + 1000 : null }
      }
      const expected = args.expectedVersion === undefined && !skill ? 0 : revision(args.expectedVersion)
      if (expected !== latest) throw new WorkspaceInputError('技能版本已更新，请重新查看')
      if (args.action === 'save') {
        if (!skill && state.skills.length >= MAX_SKILLS) throw new WorkspaceInputError('技能数量已达上限')
        const version = { version: latest + 1, description: text(args.description, 240), code: text(args.code, MAX_SCRIPT_CHARS),
          capabilities: dependencies(args.capabilities ?? []) }
        version.capabilities.forEach(scriptCapability)
        const sample = object(args.test)
        const fixtures = object(sample.fixtures ?? {})
        if (sample.calls !== undefined && Object.keys(fixtures).length) throw new WorkspaceInputError('样例请选择 fixtures 或 calls')
        const calls = sample.calls === undefined ? undefined : list(sample.calls, 4).map(value => {
          const call = object(value)
          return { name: text(call.name, 80), arguments: object(call.arguments), result: call.result }
        })
        workspaceJson(calls ?? fixtures, MAX_INPUT_CHARS)
        const expectedOutput: unknown = JSON.parse(workspaceJson(sample.expected, MAX_RESULT_CHARS))
        let index = 0
        const sampleResult = await executeScript({
          code: version.code, input: sample.input ?? null, files: [], capabilities: version.capabilities,
          async call(name, args) {
            if (calls) {
              const expected = calls[index++]
              if (!expected || name !== expected.name || !isDeepStrictEqual(expected.arguments, args)) {
                throw new WorkspaceInputError('样例调用顺序、能力名称或参数不符')
              }
              return expected.result
            }
            if (!Object.hasOwn(fixtures, name)) throw new WorkspaceInputError(`缺少能力样例：${name}`)
            return fixtures[name]
          },
        })
        if (!isDeepStrictEqual(sampleResult.output, expectedOutput) || sampleResult.used.length !== version.capabilities.length ||
          (calls && calls.length !== index)) {
          throw new WorkspaceInputError('样例结果与预期不符，或样例未覆盖声明的能力')
        }
        await ensureActive()
        version.capabilities.forEach(scriptCapability)
        await store.update(state.revision, next => {
          const saved = next.skills.find(item => item.name === name)
          if (saved) {
            saved.versions = [...saved.versions, version].slice(-MAX_VERSIONS)
            saved.active = version.version
          } else next.skills.push({ name, active: version.version, versions: [version] })
        })
        return { ok: true, name, version: version.version, active: true, verified: 'fixture' }
      }
      if (!skill) throw new WorkspaceInputError('技能不存在')
      const target = args.action === 'restore' ? skill.versions.find(item => item.version === revision(args.version, 1)) : null
      if (args.action === 'restore' && !target) throw new WorkspaceInputError('技能版本不存在')
      target?.capabilities.forEach(scriptCapability)
      await ensureActive()
      await store.update(state.revision, next => {
        next.skills.find(item => item.name === name)!.active = target?.version ?? null
      })
      return { ok: true, name, active: target?.version ?? null }
    })

  return [catalogTool, scriptTool, skillTool]
}
