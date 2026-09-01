import { AbstractTool } from './AbstractTool.js'
import { describeGroupKnowledgeEntry } from '../../utils/memory/groupKnowledge.js'
import { isExplicitGroupKnowledgeForgetRequest } from '../../utils/groupKnowledgeForgetPolicy.js'

export class ForgetGroupKnowledgeTool extends AbstractTool {
  constructor() {
    super()
    this.name = 'forgetGroupKnowledgeTool'
    this.description = '忘掉当前群一条由语义教学写入的共享定义、别名或通知规则；普通成员只能删除自己创建的内容。'
    this.parameters = {
      type: 'object',
      properties: {
        memory: { type: 'string', description: '用户要求忘掉的知识称呼，保留“我的”这一归属词，例如“我的星怒”或“地图”。' }
      },
      required: ['memory']
    }
    this.skill = {
      name: this.name,
      purpose: '精确删除当前群中由语义教学提交的一条结构化群定义、别名或通知规则。',
      whenToUse: '仅当用户明确要求忘掉、删除、清除先前教会的群知识、别名或通知规则时使用。',
      boundaries: '只操作当前群的结构化共享状态。普通成员只能删除自己创建的内容；群主、管理员和主人可处理其他人的精确条目。找不到或匹配多条时绝不删除。不能用于聊天记录、群文件本体或任何普通数据。',
      instructions: 'memory 只填写用户要忘掉的称呼，不要编造 ID。含“我的”时必须原样保留，以便按当前发言者限定。工具返回歧义时请让用户明确哪一条，不要自行挑选。',
      examples: [
        '“忘掉我的星怒” -> {"memory":"我的星怒"}',
        '“把我之前教你的地图删掉” -> {"memory":"地图"}'
      ]
    }
  }

  async func(options = {}, e = {}) {
    if (!e.group_id) return '这件事只能在群里处理。'
    if (!e.memoryManager?.forgetGroupKnowledge) return '这次没能读取当前群的记忆，我没有删除任何内容。'
    if (!isExplicitGroupKnowledgeForgetRequest(e.msg || '')) return '这句没有明确要求删除群知识，我没有删除任何内容。'

    const result = await e.memoryManager.forgetGroupKnowledge({
      groupId: e.group_id,
      requesterQQ: e.user_id,
      requesterIsGroupManager: Boolean(e.isMaster || ['owner', 'admin'].includes(e.sender?.role)),
      query: options.memory
    })
    if (result.deleted) return `已经忘掉：${result.description || describeGroupKnowledgeEntry(result.entry)}。`
    if (result.reason === 'ambiguous') {
      const candidates = result.candidateDescriptions?.join('；') || result.candidates.map(describeGroupKnowledgeEntry).join('；')
      return `我找到了不止一条可能的记忆：${candidates}。你说清楚要忘掉哪一条，我再删。`
    }
    if (result.reason === 'not-found') return '没有找到你自己教给我的这条群知识，所以我没有删除别的内容。'
    return '这次没能确认要忘掉哪条群知识，我没有删除任何内容。'
  }
}
