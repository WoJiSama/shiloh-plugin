import type { ConfigSchemaItem } from '../../../../../contracts/configSchema.js'

// 游戏模块配置:海龟汤 / 赛马娘 / 三角洲,供控制台「游戏」页嵌入表单
export const turtleSoupSchema: ConfigSchemaItem[] = [
  { component: 'Divider', label: '海龟汤' },
  { field: 'miniGames.enabled', label: '小游戏总开关', component: 'Switch', bottomHelpMessage: '总开关与下方海龟汤开关同时开启，海龟汤才响应群命令和自动补货；关闭不会改写单游戏开关' },
  { field: 'miniGames.turtleSoup.enabled', label: '海龟汤开关', component: 'Switch', bottomHelpMessage: '海龟汤独立开关；也需小游戏总开关开启。关闭后题库和配置保留' },
  { field: 'miniGames.turtleSoup.minPlayers', label: '最少开局人数', component: 'InputNumber', componentProps: { min: 1, max: 50, placeholder: '1' }, bottomHelpMessage: '报名确认制,窗口期内达到才开局;1 = 单人也可玩' },
  { field: 'miniGames.turtleSoup.joinWindowMinutes', label: '报名窗口(分钟)', component: 'InputNumber', componentProps: { min: 1, max: 60, placeholder: '5' } },
  { field: 'miniGames.turtleSoup.idleTimeoutMinutes', label: '无活动收局(分钟)', component: 'InputNumber', componentProps: { min: 1, max: 240, placeholder: '5' }, bottomHelpMessage: '问答期无人发言满此时长自动揭晓' },
  { field: 'miniGames.turtleSoup.guessCooldownSeconds', label: '猜底冷却(秒)', component: 'InputNumber', componentProps: { min: 0, max: 3600, placeholder: '30' }, bottomHelpMessage: '每人两次猜底之间的冷却,防穷举刷汤底' },
  { field: 'miniGames.turtleSoup.freshEasy', label: '简单汤保有量', component: 'InputNumber', componentProps: { min: 0, max: 50, placeholder: '2' }, bottomHelpMessage: 'easy 难度"没玩过"的汤少于该数时自动补货' },
  { field: 'miniGames.turtleSoup.freshNormal', label: '普通汤保有量', component: 'InputNumber', componentProps: { min: 0, max: 50, placeholder: '2' }, bottomHelpMessage: 'normal 难度' },
  { field: 'miniGames.turtleSoup.freshHard', label: '困难汤保有量', component: 'InputNumber', componentProps: { min: 0, max: 50, placeholder: '2' }, bottomHelpMessage: 'hard 难度' },
  { field: 'miniGames.turtleSoup.freshPoolTarget', label: '可玩鲜汤目标', component: 'InputNumber', componentProps: { min: 1, max: 50, placeholder: '2' }, bottomHelpMessage: '已过审且未被任何群玩过的不同题目数量；修复版本共享曝光史' },
  { field: 'miniGames.turtleSoup.maxPending', label: '待审池上限', component: 'InputNumber', componentProps: { min: 1, max: 100, placeholder: '默认取 4 与鲜汤目标两倍的较大值' }, bottomHelpMessage: '自动补货达到待审上限后暂停，避免审核积压反复生成' },
  { field: 'miniGames.turtleSoup.generationCallBudget', label: '每道候选模型调用上限', component: 'InputNumber', componentProps: { min: 4, max: 100, placeholder: '18' }, bottomHelpMessage: '新题至少需要生成与三次模型审核，共 4 次；修复和重试也计数，达到上限保留候选，下次人工重试重新获得一次预算' },
  { field: 'miniGames.turtleSoup.reviewModel', label: '审核模型', component: 'Input', componentProps: { placeholder: '留空 = 生成模型' }, bottomHelpMessage: '可选择另一模型做可玩性、逻辑与问答推演审核，降低同一模型的盲点' },
  { field: 'miniGames.turtleSoup.generationModel', label: '生成模型', component: 'Input', componentProps: { placeholder: '留空 = 主模型' } },
  { field: 'miniGames.turtleSoup.maxHints', label: '每局提示条数', component: 'InputNumber', componentProps: { min: 0, max: 10, placeholder: '3' } },
  { field: 'miniGames.turtleSoup.hintCooldownSeconds', label: '提示间隔(秒)', component: 'InputNumber', componentProps: { min: 0, max: 300, placeholder: '15' }, bottomHelpMessage: '防止连续领取提示跳过推理；0 = 不限' },
  { field: 'miniGames.turtleSoup.recapEveryQuestions', label: '进度卡频率', component: 'InputNumber', componentProps: { min: 0, max: 100, placeholder: '10' }, bottomHelpMessage: '每 N 次提问发一张进度卡;0 = 关闭' },
  { field: 'miniGames.turtleSoup.chooseWindowSeconds', label: '选汤窗口(秒)', component: 'InputNumber', componentProps: { min: 10, max: 300, placeholder: '60' }, bottomHelpMessage: '三选一超时自动随机开局' },
  { field: 'miniGames.turtleSoup.ratingWindowMinutes', label: '评分窗口(分钟)', component: 'InputNumber', componentProps: { min: 1, max: 120, placeholder: '5' } },
  { field: 'miniGames.turtleSoup.contentPolicy', label: '出题题材尺度', component: 'InputTextArea', bottomHelpMessage: '喂给生成模型的题材边界说明；留空时使用默认推理题材尺度' },
  { field: 'miniGames.turtleSoup.generationCustomPrompt', label: '站长补充出题指示', component: 'InputTextArea', bottomHelpMessage: '追加在出题系统提示词末尾,优先级高于默认规则(输出格式和题材底线不变)。例:优先中国现代都市背景;避免动物题材;汤面结尾必须有数字线索。留空=不追加' }
].map(item => item.component === 'InputNumber' ? {...item, componentProps: {...item.componentProps, step: 1, precision: 0}} : item)

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
