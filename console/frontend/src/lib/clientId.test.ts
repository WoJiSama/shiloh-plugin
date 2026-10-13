import { describe, it, expect, vi } from 'vitest'
import { clientId } from './clientId'
describe('HTTP draft identifiers', () => {
  it('creates unique UUIDs without randomUUID on insecure HTTP', () => {
    const original = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: original.getRandomValues.bind(original) })
    try {
      const ids = Array.from({ length: 100 }, () => clientId())
      expect(new Set(ids).size).toBe(100)
      expect(
        ids.every((id) =>
          /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)
        )
      ).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
