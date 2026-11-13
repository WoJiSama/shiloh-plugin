import { newAsyncContext } from 'quickjs-emscripten'
import { performance } from 'node:perf_hooks'

export const MAX_SCRIPT_CHARS = 8000
export const MAX_FILE_CHARS = 6000
export const MAX_FILES = 16
export const MAX_INPUT_CHARS = 8000
export const MAX_RESULT_CHARS = 2800
const MAX_CALLS = 4
const RUN_MS = 10_000
const CPU_MS = 250

export interface WorkspaceFile { name: string; content: string }

export class WorkspaceInputError extends Error {}

export function validFileName(name: unknown): name is string {
  return typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name)
}

export function workspaceJson(value: unknown, max: number): string {
  const json = JSON.stringify(value)
  if (json === undefined || json.length > max) throw new WorkspaceInputError('JSON 缺失或超过大小限制')
  return json
}

/** Only serialized data crosses the WASM boundary. Each run has its own context. */
export async function runCharacterScript(options: {
  code: string
  input: unknown
  files: WorkspaceFile[]
  capabilities: string[]
  call(name: string, args: Record<string, unknown>): Promise<unknown>
}): Promise<{ output: unknown; files: WorkspaceFile[]; used: string[] }> {
  const input = workspaceJson(options.input, MAX_INPUT_CHARS)
  const vm = await newAsyncContext()
  const deadline = performance.now() + RUN_MS
  let cpuDeadline = performance.now() + CPU_MS
  let cpuRemaining = CPU_MS
  let calls = 0
  let bridgeError: WorkspaceInputError | undefined
  const used = new Set<string>()
  vm.runtime.setMemoryLimit(12 * 1024 * 1024)
  vm.runtime.setMaxStackSize(256 * 1024)
  vm.runtime.setInterruptHandler(() => performance.now() >= Math.min(deadline, cpuDeadline))

  try {
    vm.newAsyncifiedFunction('projectCall', async (nameHandle, argsHandle) => {
      cpuRemaining = Math.max(0, cpuDeadline - performance.now())
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        if (++calls > MAX_CALLS) throw new WorkspaceInputError('脚本最多调用四次项目能力')
        const name = vm.getString(nameHandle)
        if (!options.capabilities.includes(name)) throw new WorkspaceInputError('脚本调用了未声明或未授权的能力')
        const raw = vm.getString(argsHandle)
        if (raw.length > MAX_INPUT_CHARS) throw new WorkspaceInputError('能力参数超过大小限制')
        const args: unknown = JSON.parse(raw)
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new WorkspaceInputError('能力参数必须是 JSON 对象')
        const remaining = deadline - performance.now()
        if (remaining <= 0 || cpuRemaining <= 0) throw new WorkspaceInputError('脚本已超时')
        const result = await Promise.race([
          options.call(name, args as Record<string, unknown>),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new WorkspaceInputError('数据接口读取超时')), remaining)
          }),
        ])
        used.add(name)
        return vm.newString(workspaceJson(result, 64_000))
      } catch (error) {
        bridgeError = error instanceof WorkspaceInputError ? error : new WorkspaceInputError('数据接口读取失败')
        // Even if guest code catches the exception, this run cannot commit files.
        throw bridgeError
      } finally {
        if (timer) clearTimeout(timer)
        cpuDeadline = performance.now() + cpuRemaining
      }
    }).consume(fn => vm.setProp(vm.global, 'projectCall', fn))

    const program = `(() => {
      "use strict";
      const encode = JSON.stringify, decode = JSON.parse;
      const inputs = decode(${JSON.stringify(input)});
      const initial = decode(${JSON.stringify(JSON.stringify(options.files))});
      const files = new Map(initial.map(({name, content}) => [name, content]));
      const call = projectCall;
      delete globalThis.projectCall;
      const project = Object.freeze({call: (name, args = {}) => {
        if (typeof name !== 'string' || name.length > 80) throw new Error("无效能力名称");
        return decode(call(name, encode(args)));
      }});
      const workspace = Object.freeze({
        list: () => [...files.keys()],
        read: name => files.get(name) ?? null,
        write: (name, content) => {
          if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name) ||
              typeof content !== 'string' || content.length > ${MAX_FILE_CHARS}) throw new Error("文件名或内容无效");
          if (!files.has(name) && files.size >= ${MAX_FILES}) throw new Error("工作区文件数量已达上限");
          files.set(name, content);
        },
        remove: name => files.delete(name),
      });
      const execute = decode(${JSON.stringify(JSON.stringify(options.code))});
      const run = Function("input", "project", "workspace", '"use strict";\\n' + execute);
      const output = run(inputs, project, workspace);
      if (output === undefined || (output && typeof output.then === "function")) throw new Error("须返回可序列化的 JSON");
      return encode({output, files: [...files].map(([name, content]) => ({name, content}))});
    })()`
    const result = await vm.evalCodeAsync(program, 'workspace.js', { type: 'global' })
    if (result.error) {
      result.error.dispose()
      throw bridgeError ?? new WorkspaceInputError('脚本异常或超出时间、内存限制')
    }
    const serialized = result.value.consume(value => vm.getString(value))
    if (bridgeError) throw bridgeError
    if (performance.now() >= deadline) throw new WorkspaceInputError('脚本已超时')
    if (serialized.length > MAX_FILES * (MAX_FILE_CHARS * 6 + 100) + MAX_RESULT_CHARS * 6 + 1000) {
      throw new WorkspaceInputError('脚本结果超过大小限制')
    }
    const parsed = JSON.parse(serialized) as { output: unknown; files: WorkspaceFile[] }
    workspaceJson(parsed.output, MAX_RESULT_CHARS)
    if (!Array.isArray(parsed.files) || parsed.files.length > MAX_FILES ||
      parsed.files.some(file => !file || !validFileName(file.name) || typeof file.content !== 'string' || file.content.length > MAX_FILE_CHARS) ||
      new Set(parsed.files.map(file => file.name)).size !== parsed.files.length) {
      throw new WorkspaceInputError('工作区文件无效')
    }
    return { ...parsed, used: [...used] }
  } finally {
    vm.dispose()
    vm.runtime.dispose()
  }
}
