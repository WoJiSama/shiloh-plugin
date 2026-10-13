import { describe, expect, it } from 'vitest'
import { uploadFileName } from './commands'

describe('asset file identity', () => {
  it('rejects names the backend would silently collapse onto a different existing file', () => {
    for (const name of [
      'a:b:c.json',
      'a/bc.json',
      'a\\bc.json',
      'abc*.json',
      'abc?.json',
      'abc".json',
      '<abc>.json',
      'abc|.json'
    ])
      expect(uploadFileName(name)).toBeNull()
    expect(uploadFileName('abc.json')).toBe('abc.json')
  })
  it('matches the backend basename constraints and extension whitelist', () => {
    expect(uploadFileName(' 我的牌堆 v2.yaml ')).toBe('我的牌堆 v2.yaml')
    expect(uploadFileName('seal-ext.cjs')).toBe('seal-ext.cjs')
    expect(uploadFileName('.hidden.json')).toBeNull()
    expect(uploadFileName('deck.txt')).toBeNull()
    expect(uploadFileName(`${'a'.repeat(82)}.json`)).toBeNull()
  })
})
