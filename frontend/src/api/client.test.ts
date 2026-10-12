import { describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './client'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

describe('ApiClient auth', () => {
  it('refreshes the token once on 401 and retries', async () => {
    const tokens: boolean[] = []
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get('Authorization')
      return auth === 'Bearer fresh' ? json(200, { user_id: 'u', display_name: 'U', roles: [] }) : json(401, {})
    })
    const onUnauthenticated = vi.fn()
    const api = new ApiClient('http://x/api/v1', fetchImpl, {
      getIdToken: async (force) => {
        tokens.push(force)
        return force ? 'fresh' : 'stale'
      },
      onUnauthenticated,
    })
    await expect(api.me()).resolves.toMatchObject({ user_id: 'u' })
    expect(tokens).toEqual([false, true])
    expect(onUnauthenticated).not.toHaveBeenCalled()
  })

  it('signals re-authentication when a fresh token is still rejected', async () => {
    const onUnauthenticated = vi.fn()
    const api = new ApiClient('http://x', async () => json(401, { error: { code: 'TOKEN_EXPIRED', message: 'exp', request_id: 'r' } }), {
      getIdToken: async () => 't',
      onUnauthenticated,
    })
    await expect(api.me()).rejects.toMatchObject({ status: 401, code: 'TOKEN_EXPIRED', requestId: 'r' })
    expect(onUnauthenticated).toHaveBeenCalledOnce()
  })

  it('maps network failures to a retryable ApiError', async () => {
    const api = new ApiClient('http://x', async () => {
      throw new TypeError('Failed to fetch')
    }, { getIdToken: async () => 't', onUnauthenticated: () => {} })
    const e = await api.me().catch((x) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect(e.retryable).toBe(true)
  })
})
