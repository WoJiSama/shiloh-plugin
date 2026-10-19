import type { ConfigSchemaItem } from '../../../../../contracts/configSchema.js'

// 游戏模块配置:海龟汤 / 赛马娘 / 三角洲,供控制台「游戏」页嵌入表单
export const turtleSoupSchema: ConfigSchemaItem[] = [
  { component: 'Divider', label: '海龟汤' },
  { field: 'turtleSoup.enabled', label: '海龟汤开关', component: 'Switch', bottomHelpMessage: '群聊海龟汤推理:AI 主持问答、猜汤底、MVP 评选' },
  { field: 'turtleSoup.minPlayers', label: '最少开局人数', component: 'InputNumber', componentProps: { min: 1, max: 20, placeholder: '1' }, bottomHelpMessage: '报名确认制,窗口期内达到才开局;1 = 单人也可玩' },
  { field: 'turtleSoup.joinWindowMinutes', label: '报名窗口(分钟)', component: 'InputNumber', componentProps: { min: 1, max: 60, placeholder: '5' } },
  { field: 'turtleSoup.idleTimeoutMinutes', label: '无活动收局(分钟)', component: 'InputNumber', componentProps: { min: 1, max: 120, placeholder: '5' }, bottomHelpMessage: '问答期无人发言满此时长自动揭晓' },
  { field: 'turtleSoup.guessCooldownSeconds', label: '猜底冷却(秒)', component: 'InputNumber', componentProps: { min: 0, max: 600, placeholder: '30' }, bottomHelpMessage: '每人两次猜底之间的冷却,防穷举刷汤底' },
  { field: 'turtleSoup.similarityHitThreshold', label: '猜底命中相似度', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.01, placeholder: '0.9' }, bottomHelpMessage: '字面相似度达到即判中,不再过模型' },
  { field: 'turtleSoup.freshPoolTarget', label: '鲜汤保有量', component: 'InputNumber', componentProps: { min: 1, max: 50, placeholder: '6' }, bottomHelpMessage: '「没有任何群玩过」的汤少于该数量时后台自动生成补货(按 active+待审计)' },
  { field: 'turtleSoup.generationModel', label: '生成模型', component: 'Input', componentProps: { placeholder: '留空 = 主模型' } },
  { field: 'turtleSoup.maxHints', label: '每局提示条数', component: 'InputNumber', componentProps: { min: 0, max: 10, placeholder: '3' } },
  { field: 'turtleSoup.recapEveryQuestions', label: '进度卡频率', component: 'InputNumber', componentProps: { min: 0, max: 100, placeholder: '10' }, bottomHelpMessage: '每 N 次提问发一张进度卡;0 = 关闭' },
  { field: 'turtleSoup.chooseWindowSeconds', label: '选汤窗口(秒)', component: 'InputNumber', componentProps: { min: 10, max: 600, placeholder: '60' }, bottomHelpMessage: '三选一超时自动随机开局' },
  { field: 'turtleSoup.ratingWindowMinutes', label: '评分窗口(分钟)', component: 'InputNumber', componentProps: { min: 1, max: 120, placeholder: '5' } },
  { field: 'turtleSoup.contentPolicy', label: '出题题材尺度', component: 'InputTextArea', bottomHelpMessage: '喂给生成模型的题材边界说明' }
]

export const umaRaceSchema: ConfigSchemaItem[] = [
  { component: 'Divider', label: '赛马娘' },
  { field: 'umaRace.enabled', label: '赛马娘开关', component: 'Switch' },
  { field: 'umaRace.minPlayers', label: '最少人数', component: 'InputNumber', componentProps: { min: 2, max: 20, placeholder: '8' } },
  { field: 'umaRace.maxPlayers', label: '最多人数', component: 'InputNumber', componentProps: { min: 2, max: 20, placeholder: '8' } },
  { field: 'umaRace.lobbySeconds', label: '大厅等待(秒)', component: 'InputNumber', componentProps: { min: 30, max: 900, placeholder: '300' } },
  { field: 'umaRace.raceStageSeconds', label: '比赛阶段(秒)', component: 'InputNumber', componentProps: { min: 10, max: 300, placeholder: '45' } },
  { field: 'umaRace.cooldownSeconds', label: '局间冷却(秒)', component: 'InputNumber', componentProps: { min: 0, max: 3600, placeholder: '30' } },
  { field: 'umaRace.winPoints', label: '第一名积分', component: 'InputNumber', componentProps: { min: 1, max: 100, placeholder: '6' } },
  { field: 'umaRace.secondPoints', label: '第二名积分', component: 'InputNumber', componentProps: { min: 0, max: 100, placeholder: '4' } },
  { field: 'umaRace.thirdPoints', label: '第三名积分', component: 'InputNumber', componentProps: { min: 0, max: 100, placeholder: '2' } },
  { field: 'umaRace.participationPoints', label: '参与积分', component: 'InputNumber', componentProps: { min: 0, max: 100, placeholder: '1' } },
  { field: 'umaRace.rankLimit', label: '排行榜人数', component: 'InputNumber', componentProps: { min: 3, max: 100, placeholder: '10' } }
]

export const deltaForceSchema: ConfigSchemaItem[] = [
  { component: 'Divider', label: '三角洲行动' },
  { field: 'deltaForceSystem.enabled', label: '三角洲开关', component: 'Switch', bottomHelpMessage: '查询干员/武器/地图资料与每日战役报告' },
  { field: 'deltaForceSystem.apiBaseUrl', label: '资料 API 地址', component: 'Input', componentProps: { placeholder: 'https://...' } },
  { field: 'deltaForceSystem.apiKey', label: '资料 API 密钥', component: 'InputPassword' },
  { field: 'deltaForceSystem.timeoutMs', label: '超时(毫秒)', component: 'InputNumber', componentProps: { min: 1000, max: 60000, step: 500, placeholder: '10000' } },
  { field: 'deltaForceSystem.objectCacheEnabled', label: '对象缓存', component: 'Switch', bottomHelpMessage: '干员/武器等静态资料本地缓存' },
  { field: 'deltaForceSystem.objectCacheRefreshMinutes', label: '缓存刷新(分钟)', component: 'InputNumber', componentProps: { min: 10, max: 1440, placeholder: '360' } }
]
