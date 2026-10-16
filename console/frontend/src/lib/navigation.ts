import {
  MessageCircle,
  Bot,
  Users,
  Drama,
  BrainCircuit,
  Workflow,
  ShieldCheck,
  UserRoundCog,
  Terminal,
  Activity,
  Database,
  ImagePlus
} from 'lucide-vue-next'
export const navigation = [
  {
    label: '日常运营',
    items: [
      { path: '/', label: '机器人', icon: Bot, hint: '账号与运行状态' },
      { path: '/groups', label: '群聊', icon: Users, hint: '服务群与收发统计' },
      { path: '/group-admin', label: '群管理', icon: UserRoundCog, hint: '入群验证、广告与群通知' }
    ]
  },
  {
    label: '机器人能力',
    items: [
      {
        path: '/conversation',
        label: '对话设置',
        icon: MessageCircle,
        hint: '触发、权限与回复方式'
      },
      { path: '/persona', label: '人设与绑定', icon: Drama, hint: '人设库与身份分配' },
      { path: '/ai', label: 'AI 模型', icon: BrainCircuit, hint: '渠道与模型配置' },
      { path: '/commands', label: '命令 / 骰子', icon: Terminal, hint: '命令与规则管理' },
      { path: '/semantic', label: '语义记忆', icon: Database, hint: '长期记忆与召回' }
    ]
  },
  {
    label: '消息与运行',
    items: [
      { path: '/pipeline', label: '消息与搬运', icon: Workflow, hint: '可靠管道与平台授权' },
      { path: '/risk', label: '风控策略', icon: ShieldCheck, hint: '审查、限流与通知' },
      { path: '/observe', label: '运行观测', icon: Activity, hint: '请求轨迹与失败原因' }
    ]
  },
  {
    label: '创作工具',
    items: [{ path: '/draw', label: '生图工作台', icon: ImagePlus, hint: '文生图与图生图' }]
  }
]
export const pages = navigation.flatMap((group) =>
  group.items.map((item) => ({ ...item, group: group.label }))
)
