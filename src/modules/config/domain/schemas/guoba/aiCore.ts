import type { ConfigSchemaItem } from '../../../../../contracts/configSchema.js'
import aiCore from '../shared/aiCore.js'

// 自定义补充提示尚无控制台编辑入口，其余对话/任务模型项由控制台管理。
const schema: ConfigSchemaItem[] = [
  { component: 'SOFT_GROUP_BEGIN', label: '自定义补充提示' },
  ...aiCore.filter(item => item.field === 'systemContent')
]

export default schema
