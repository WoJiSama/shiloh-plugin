// 画图请求里的"群友头像参考"只在明确指真人时才应该挂；
// "蔚蓝档案里面的小鸟游星野"这类作品角色请求若被昵称匹配挂上真人头像，
// 既指认错了人，也容易触发上游"真人改造"内容审核。

const FICTIONAL_WORK_MARKERS = [
  /蔚蓝档案|碧蓝档案|蓝色星原|蓝反/i,
  /原神|崩坏|星穹铁道|绝区零|米哈游|miHoYo|HoYoverse/i,
  /明日方舟|少女前线|碧蓝航线|战双帕弥什|深空之眼|鸣潮/i,
  /FGO|fate|Fate/i,
  /火影|海贼王|死神|龙珠|鬼灭|咒术回战|进击的巨人/i,
  /龙族|全职高手|斗破|凡人修仙/i,
  /mygo|MyGO|孤独摇滚|轻音|EVA|新世纪福音|初音|东方project|东方Project/i,
  /赛马娘|umamusume|Umamusume|闪耀优俊少女/i,
  /间谍过家家|特工过家家|葬送的芙莉莲|芙莉莲|药屋少女的呢喃|葬送/i
]

const FICTIONAL_CONTEXT_MARKERS = /原作|番剧|同人|二次元角色|动漫角色|动画角色|漫画角色|游戏角色|galgame|乙女游戏/i
const FICTIONAL_STRUCTURAL_MARKER = /(?:动漫|动画|漫画|游戏|小说|电影|作品|番剧|剧里|片里)(?:里面|里|中|中的|里的)/i

// 昵称前面的字符段若能整体剥掉这些常见动词/结构词后缀，说明昵称是独立称呼；
// 剩下内容非空则视为更长名字的一部分（如"小鸟游|星野"）
const INDEPENDENT_REFERENCE_SUFFIX = /(?:我们|你们|他们|她们|它们|这个|那个|这位|那位|群友|[画绘帮给把将叫请让找换捏做生成版个只张幅位号里中的和跟与我你他她它咱们群这那])+$/

export function mentionsFictionalCharacterSource(text = "") {
  const content = String(text || "")
  if (!content.trim()) return false
  if (FICTIONAL_CONTEXT_MARKERS.test(content)) return true
  if (FICTIONAL_STRUCTURAL_MARKER.test(content)) return true
  return FICTIONAL_WORK_MARKERS.some(pattern => pattern.test(content))
}

export function isNicknamePartOfLongerName(text = "", nickname = "") {
  const content = String(text || "")
  const name = String(nickname || "").trim()
  if (!content || !name) return false
  const index = content.indexOf(name)
  if (index <= 0) return false
  // 截取昵称前最多 6 个字符、贪婪剥掉常见动词/结构词后缀；剩下内容非空即视为长名片段
  const preceding = content.slice(Math.max(0, index - 6), index)
  const remainder = preceding.replace(INDEPENDENT_REFERENCE_SUFFIX, "")
  return remainder.length > 0
}

/** 昵称兜底匹配到群友前先过这道闸：像作品角色的请求不要挂真人头像 */
export function shouldSkipNicknameAvatarReference(text = "", matchedNickname = "") {
  if (mentionsFictionalCharacterSource(text)) return true
  if (isNicknamePartOfLongerName(text, matchedNickname)) return true
  return false
}
