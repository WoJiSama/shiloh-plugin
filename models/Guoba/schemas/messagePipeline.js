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
