import { describe, expect, it } from 'vitest'
import { config, resolveConfig, resolveUseMocks } from './config'

describe('mock transport is disabled by default', () => {
  it('only the exact string "true" enables mocks', () => {
    expect(resolveUseMocks({})).toBe(false)
    expect(resolveUseMocks({ VITE_USE_MOCKS: '' })).toBe(false)
    expect(resolveUseMocks({ VITE_USE_MOCKS: 'false' })).toBe(false)
    expect(resolveUseMocks({ VITE_USE_MOCKS: '1' })).toBe(false)
    expect(resolveUseMocks({ VITE_USE_MOCKS: 'TRUE' })).toBe(false)
    expect(resolveUseMocks({ VITE_USE_MOCKS: 'true' })).toBe(true)
  })

  it('runtime config in tests uses the real API by default', () => {
    expect(config.useMocks).toBe(false)
    expect(resolveConfig({}).apiBaseUrl).toBe('http://localhost:8000/api/v1')
  })

  it('.env.example ships with mocks off and no secrets', async () => {
    // Vite refuses to import .env files, so read it with Node fs (tests run in Node).
    const spec = 'node:fs'
    const fs = (await import(/* @vite-ignore */ spec)) as { readFileSync(p: string, enc: string): string }
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd() // vitest runs from frontend/
    const text = fs.readFileSync(`${cwd}/.env.example`, 'utf8')
    expect(text).toMatch(/^VITE_USE_MOCKS=false$/m)
    expect(text).toMatch(/^VITE_API_BASE_URL=http:\/\/localhost:8000\/api\/v1$/m)
    expect(text).not.toMatch(/^AI_SERVICE_TOKEN=/m)
    expect(text).not.toMatch(/private_key/i)
  })
})
