function cleanTargetList(value = '') {
  return String(value || '')
    .replace(/^error:\s*/i, '')
    .replace(/^当前群未找到要艾特的成员:\s*/u, '')
    .trim()
}

export function buildMentionMembersFailureReply(error = '') {
  const text = String(error || '')
  if (/当前群未找到要艾特的成员/u.test(text)) {
    const targets = cleanTargetList(text)
    return targets
      ? `我这边没对上“${targets}”这个名字……可能群名片不一样。你直接 @对方一下，我就能喊到。`
      : '我这边没对上要喊的人。你直接 @对方一下，我就能喊到。'
  }
  if (/没有指定要艾特的成员/u.test(text)) {
    return '你想喊谁呀？直接 @对方一下，我就能接着喊。'
  }
  if (/无法读取群成员/u.test(text)) {
    return '我这边这会儿没拿到群成员列表，暂时没法帮你喊人。'
  }
  return '我这次没把人喊出来，先不装作已经喊到了。'
}
