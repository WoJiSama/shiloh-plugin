export default [
  { component: "SOFT_GROUP_BEGIN", label: "消息可靠管道" },
  {
    field: "messagePipeline.enabled",
    label: "启用可靠消息管道",
    component: "Switch",
    bottomHelpMessage: "从 OneBot 原始事件捕获消息，独立处理近期记录、长期归档和媒体任务"
  },
  {
    field: "messagePipeline.mediaAutoRelay",
    label: "自动搬运视频分享",
    component: "Switch",
    bottomHelpMessage: "B站和抖音分享按群独立进入持久任务，不受 AI 聊天限流影响"
  },
  {
    field: "messagePipeline.eventTtlMinutes",
    label: "事件状态保留分钟",
    component: "InputNumber",
    componentProps: { min: 30, max: 1440, step: 30, placeholder: "360" }
  },
  {
    field: "messagePipeline.deliveryTtlHours",
    label: "交付状态保留小时",
    component: "InputNumber",
    componentProps: { min: 1, max: 168, step: 1, placeholder: "24" }
  },
  {
    field: "messagePipeline.deliveryMaxAttempts",
    label: "媒体发送最大尝试",
    component: "InputNumber",
    componentProps: { min: 1, max: 10, step: 1, placeholder: "4" }
  },
  {
    field: "messagePipeline.eventConcurrency",
    label: "事件并发数",
    component: "InputNumber",
    componentProps: { min: 1, max: 32, step: 1, placeholder: "8" }
  },
  {
    field: "messagePipeline.deliveryConcurrency",
    label: "媒体交付并发数",
    component: "InputNumber",
    componentProps: { min: 1, max: 16, step: 1, placeholder: "4" }
  },
  {
    field: "messagePipeline.mediaArtifactTtlSeconds",
    label: "共享视频保留秒数",
    component: "InputNumber",
    bottomHelpMessage: "同一视频并发搬运时复用下载产物，引用结束后短期保留",
    componentProps: { min: 10, max: 600, step: 10, placeholder: "120" }
  },
  {
    field: "messagePipeline.mediaArtifactMaxEntries",
    label: "共享视频条目上限",
    component: "InputNumber",
    componentProps: { min: 1, max: 32, step: 1, placeholder: "8" }
  },
  {
    field: "messagePipeline.mediaArtifactMaxIdleMb",
    label: "共享视频磁盘上限 MB",
    component: "InputNumber",
    componentProps: { min: 64, max: 2048, step: 64, placeholder: "512" }
  },
  {
    field: "messagePipeline.mediaArtifactMaxEncodedMb",
    label: "Base64 复用文件上限 MB",
    component: "InputNumber",
    bottomHelpMessage: "超过此大小只共享 MP4，不在内存中保留 Base64",
    componentProps: { min: 0, max: 256, step: 16, placeholder: "64" }
  },
  {
    field: "messagePipeline.mediaSharedHostDir",
    label: "共享媒体宿主目录",
    component: "Input",
    bottomHelpMessage: "NapCat 等容器可见的宿主目录；配置后视频以文件路径发送，不再以大 Base64 穿过 OneBot WebSocket。多账号自动按 /opt/napcat-<QQ>/config 探测，此项为主号/默认目录",
    componentProps: { placeholder: "如 /opt/napcat/config/bl-chat-media，留空走 Base64" }
  },
  {
    field: "messagePipeline.mediaSharedContainerDir",
    label: "共享媒体容器内目录",
    component: "Input",
    bottomHelpMessage: "同一目录在 NapCat 容器内的路径，各 napcat 容器一致",
    componentProps: { placeholder: "如 /app/napcat/config/bl-chat-media，留空走 Base64" }
  },
  { component: "SOFT_GROUP_BEGIN", label: "B站高清搬运授权" },
  {
    field: "bilibiliQualityRelay.enabled",
    label: "启用高清搬运命令",
    component: "Switch",
    bottomHelpMessage: "开放 .高清搬运 命令；自动搬运始终匿名最低清晰度，不受此开关影响"
  },
  {
    field: "bilibiliQualityRelay.autoUseAuthorizedForMemberOnly",
    label: "试看内容授权复试",
    component: "Switch",
    bottomHelpMessage: "自动搬运匿名请求被判试看或需登录时，用 .B站授权 扫码的账号再试一次完整资源"
  },
  { component: "SOFT_GROUP_BEGIN", label: "管理群定时健康报告" },
  {
    field: "mediaRelayAdminReport.enabled",
    label: "启用管理群健康报告",
    component: "Switch",
    bottomHelpMessage: "按间隔向管理群推送健康报告卡面：各号登录态与内存占用、今日收发统计、失败汇总（搬运/事件/发送任一失败都会列出）。保存后下一周期生效，无需重启"
  },
  {
    field: "mediaRelayAdminReport.groupId",
    label: "管理群号",
    component: "Input",
    bottomHelpMessage: "接收定时报告的群；机器人需在该群内",
    componentProps: { placeholder: "如 953676639" }
  },
  {
    field: "mediaRelayAdminReport.intervalHours",
    label: "推送间隔小时",
    component: "InputNumber",
    bottomHelpMessage: "搬运投递统计窗口与推送周期相同；机器人状态与收发统计始终取当下/今日",
    componentProps: { min: 1, max: 168, step: 1, placeholder: "24" }
  },
  { component: "SOFT_GROUP_BEGIN", label: "YouTube 自动搬运授权" },
  {
    field: "youtubeRelay.cookieHeader",
    label: "YouTube 登录 Cookie",
    component: "InputPassword",
    bottomHelpMessage: "粘贴已登录 YouTube 浏览器请求中的完整 Cookie 值；用于受登录、会员或私享权限保护的视频",
    componentProps: { placeholder: "未配置时匿名访问" }
  },
  {
    field: "youtubeRelay.poToken",
    label: "YouTube PO Token",
    component: "InputPassword",
    bottomHelpMessage: "可选；仅在 yt-dlp 报 YouTube 机器人校验时填写。保存后重启服务生效",
    componentProps: { placeholder: "未配置时不传递 PO Token" }
  }
]
