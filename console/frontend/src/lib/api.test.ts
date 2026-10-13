import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'

afterEach(() => vi.unstubAllGlobals())
describe('upstream authentication failures', () => {
  it('keeps a valid console session when a proxied tool returns 401', async () => {
    const unauthorized = vi.fn()
    window.addEventListener('console:unauthorized', unauthorized)
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response('{"error":"tool credentials invalid"}', { status: 401 })
        )
        .mockResolvedValueOnce(new Response('{"username":"admin","tokenWorks":false}'))
    )
    try {
      await expect(api('/bl-chat/semantic-memory/api/stats')).rejects.toMatchObject({ status: 401 })
      expect(unauthorized).not.toHaveBeenCalled()
      expect(fetch).toHaveBeenLastCalledWith(
        '/api/auth/state',
        expect.objectContaining({ credentials: 'same-origin' })
      )
    } finally {
      window.removeEventListener('console:unauthorized', unauthorized)
    }
  })
  it('reports expiry when both the upstream request and console session are unauthorized', async () => {
    const unauthorized = vi.fn()
    window.addEventListener('console:unauthorized', unauthorized)
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('{}', { status: 401 }))
        .mockResolvedValueOnce(new Response('{"username":null,"tokenWorks":false}'))
    )
    try {
      await expect(api('/bl-chat/commands/api/list')).rejects.toMatchObject({ status: 401 })
      expect(unauthorized).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('console:unauthorized', unauthorized)
    }
  })
})

it('accepts a token link and removes it from the address even when browser storage is blocked', async () => {
  vi.resetModules()
  const replaceState = vi.fn()
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('blocked')
    }
  })
  vi.stubGlobal('location', {
    href: 'http://localhost/?token=fixture-token#/groups',
    origin: 'http://localhost'
  })
  vi.stubGlobal('history', { state: null, replaceState })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')))
  const client = await import('./api')
  await client.api('/api/auth/state')
  expect(vi.mocked(fetch).mock.calls[0][1]?.headers instanceof Headers).toBe(true)
  expect((vi.mocked(fetch).mock.calls[0][1]?.headers as Headers).get('x-console-token')).toBe(
    'fixture-token'
  )
  expect(String(replaceState.mock.calls[0][2])).toBe('http://localhost/#/groups')
})
