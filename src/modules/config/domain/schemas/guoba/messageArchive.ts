import type { ConfigSchemaItem } from '../../../../../contracts/configSchema.js'
const schema: ConfigSchemaItem[] = [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "聊天归档"
  },
  {
    field: "messageArchive.enabled",
    label: "长期归档开关",
    component: "Switch",
    bottomHelpMessage: "开启后把收到的消息追加写入本地 ndjson 文件，用于管理员查询；不会下载图片或视频"
  },
  {
    field: "messageArchive.retentionDays",
    label: "归档保留天数",
    component: "InputNumber",
    bottomHelpMessage: "超过该天数的归档文件会定期清理",
    componentProps: { min: 1, max: 365, step: 1, placeholder: "7" }
  },
  {
    field: "messageArchive.includePrivate",
    label: "归档私聊",
    component: "Switch",
    bottomHelpMessage: "默认关闭；开启后也保存私聊消息归档"
  },
  {
    field: "messageArchive.includeGroups",
    label: "启用归档群",
    component: "GTags",
    bottomHelpMessage: "为空表示所有群都归档；填写后只归档这些群",
    componentProps: { allowAdd: true, allowDel: true }
  },
  {
    field: "messageArchive.excludeGroups",
    label: "排除归档群",
    component: "GTags",
    bottomHelpMessage: "这些群不会写入长期归档",
    componentProps: { allowAdd: true, allowDel: true }
  },
  {
    field: "messageArchive.globalAdmins",
    label: "归档全局管理员",
    component: "GTags",
    bottomHelpMessage: "这些 QQ 可以查询所有群归档；主人始终拥有全局权限",
    componentProps: { allowAdd: true, allowDel: true }
  },
  {
    field: "messageArchive.groupAdmins",
    label: "每群归档管理员",
    component: "GSubForm",
    bottomHelpMessage: "群主可通过命令为本群配置；这些 QQ 只能查询对应群的归档",
    componentProps: {
      multiple: true,
      schemas: [
        { field: "groupId", label: "群号", component: "Input" },
        {
          field: "admins",
          label: "管理员 QQ",
          component: "GTags",
          componentProps: { allowAdd: true, allowDel: true }
        }
      ]
    }
  },
  {
    field: "messageArchive.maxMessageLength",
    label: "单条最大字符",
    component: "InputNumber",
    bottomHelpMessage: "超长消息归档时会截断，避免刷屏占用过大磁盘",
    componentProps: { min: 500, max: 50000, step: 500, placeholder: "5000" }
  },
  {
    field: "messageArchive.storeMediaUrl",
    label: "保存媒体 URL",
    component: "Switch",
    bottomHelpMessage: "只保存 CQ 元数据中的 URL，不下载媒体文件"
  },
  {
    field: "messageArchive.baseDir",
    label: "归档目录",
    component: "Input",
    bottomHelpMessage: "相对插件目录或绝对路径；默认 data/message_archive"
  }
]

export default schema
