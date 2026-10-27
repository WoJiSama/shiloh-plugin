// 按人挖口头禅（纯函数）：从归档消息里找出每个群友的"专属说法"——
// 他高频说、且别人基本不说的短词。供高好感度对象的风格匹配注入。
export interface UserStyleMessage { userId: string; text: string }
export interface UserCatchphrases { userId: string; words: string[]; messageCount: number }

export interface MineUserStyleOptions {
  /** 每人最少消息数（低于此不建模） */
  minUserMessages?: number
  /** 词的最低出现次数 */
  minWordCount?: number
  /** 词的"专属度"：该用户对此词的占比下限（0-1） */
  minOwnership?: number
  /** 每人最多取几个词 */
  maxWordsPerUser?: number
  /** 最多保留多少人 */
  maxUsers?: number
  /** 排除词（敏感词/常用词表外再排除） */
  blockedWords?: string[]
}

const COMMON_WORDS = new Set([
  '哈哈', '哈哈哈', '哈哈哈哈', '这个', '那个', '什么', '怎么', '可以', '没有', '就是', '然后',
  '但是', '觉得', '现在', '知道', '时候', '这样', '一下', '不是', '一个', '还是', '你们', '我们',
  '他们', '自己', '真的', '确实', '应该', '可能', '直接', '出来', '进去', '问题', '东西', '事情',
  '今天', '昨天', '明天', '晚上', '早上', '下午', '游戏', '手机', '电脑', '工作', '吃饭', '睡觉',
  '好的', '好吧', '行吧', '没事', '谢谢', '对不起', '厉害', '牛逼', '卧槽', '我靠', '草',
])

export function mineUserCatchphrases(messages: UserStyleMessage[], options: MineUserStyleOptions = {}): UserCatchphrases[] {
  const minUserMessages = Math.max(5, options.minUserMessages ?? 20)
  const minWordCount = Math.max(2, options.minWordCount ?? 4)
  const minOwnership = Math.min(1, Math.max(0.3, options.minOwnership ?? 0.6))
  const maxWordsPerUser = Math.min(6, Math.max(1, options.maxWordsPerUser ?? 4))
  const maxUsers = Math.min(50, Math.max(1, options.maxUsers ?? 30))
  const blocked = new Set((options.blockedWords || []).map(w => String(w).toLowerCase()))

  const userCounts = new Map<string, number>()
  const wordByUser = new Map<string, Map<string, number>>()
  const wordTotal = new Map<string, number>()

  for (const message of messages) {
    const userId = String(message.userId || '')
    const text = String(message.text || '')
    if (!userId || !text) continue
    userCounts.set(userId, (userCounts.get(userId) || 0) + 1)
    const words = extractCandidateWords(text)
    if (!words.length) continue
    let userWords = wordByUser.get(userId)
    if (!userWords) { userWords = new Map(); wordByUser.set(userId, userWords) }
    for (const word of words) {
      userWords.set(word, (userWords.get(word) || 0) + 1)
      wordTotal.set(word, (wordTotal.get(word) || 0) + 1)
    }
  }

  const result: UserCatchphrases[] = []
  for (const [userId, count] of userCounts) {
    if (count < minUserMessages) continue
    const userWords = wordByUser.get(userId)
    if (!userWords) continue
    const scored: { word: string; score: number }[] = []
    for (const [word, wordCount] of userWords) {
      if (wordCount < minWordCount) continue
      const total = wordTotal.get(word) || wordCount
      const ownership = wordCount / total
      if (ownership < minOwnership) continue
      // 分数 = 专属度 × log(次数)：既要是他的词，也要真常用
      scored.push({ word, score: ownership * Math.log2(wordCount + 1) * (word.length >= 3 ? 1.2 : 1) })
    }
    scored.sort((a, b) => b.score - a.score)
    const words = [...new Set(scored.map(item => item.word))].slice(0, maxWordsPerUser)
    if (words.length) result.push({ userId, words, messageCount: count })
  }
  return result.sort((a, b) => b.messageCount - a.messageCount).slice(0, maxUsers)
}

function extractCandidateWords(text: string): string[] {
  const cleaned = String(text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@\S+/g, '')
    .replace(/\[CQ:[^\]]+\]/g, '')
    .replace(/\[图片\]|\[表情\]|\[动画表情\]/g, '')
  const cjk = cleaned.match(/[\u4e00-\u9fa5]{2,6}/g) || []
  const latin = (cleaned.match(/[a-zA-Z]{3,10}/g) || []).map(word => word.toLowerCase())
  return [...cjk, ...latin].filter(word => !COMMON_WORDS.has(word) && !/^\d+$/.test(word) && word.length >= 2)
}
