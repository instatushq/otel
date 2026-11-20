import { describe, expect, it } from 'vitest'
import { scrubText, scrubUrl, scrubValue } from '../src/core/scrub'

describe('scrubUrl', () => {
  it('filters secrets in the query and hash and drops credentials', () => {
    expect(
      scrubUrl(
        'https://user:pass@app.example/a?q=shoes&token=abc&api_key=1#access_token=z'
      )
    ).toBe(
      'https://app.example/a?q=shoes&token=[Filtered]&api_key=[Filtered]#access_token=[Filtered]'
    )
  })

  it('filters card numbers in any parameter', () => {
    expect(scrubUrl('/pay?number=4111111111111111&step=2')).toBe(
      '/pay?number=[Filtered]&step=2'
    )
  })

  it('leaves ordinary URLs alone', () => {
    expect(scrubUrl('/checkout?step=2')).toBe('/checkout?step=2')
  })
})

describe('scrubValue', () => {
  it('filters values under sensitive keys', () => {
    expect(scrubValue('Authorization', 'Bearer x')).toBe('[Filtered]')
    expect(scrubValue('sessionId', 'abc')).toBe('[Filtered]')
    expect(scrubValue('plan', 'pro')).toBe('pro')
  })

  it('filters card numbers in text', () => {
    expect(scrubText('paid with 4111-1111-1111-1111 today')).toBe(
      'paid with [Filtered] today'
    )
    expect(scrubText('order 12345')).toBe('order 12345')
    expect(scrubText('at 1763600000123')).toBe('at 1763600000123')
  })
})

describe('scrubValue on nested values', () => {
  it('filters secrets inside objects and arrays', () => {
    expect(
      scrubValue('request', {
        url: '/login',
        body: { password: 'hunter2', note: 'card 4242 4242 4242 4242' },
        headers: [{ authorization: 'Bearer x' }]
      })
    ).toEqual({
      url: '/login',
      body: { password: '[Filtered]', note: 'card [Filtered]' },
      headers: [{ authorization: '[Filtered]' }]
    })
  })

  it('keeps a value used twice and only cuts real cycles', () => {
    const address = { city: 'Cairo' }
    expect(
      scrubValue('order', { billing: address, shipping: address })
    ).toEqual({
      billing: { city: 'Cairo' },
      shipping: { city: 'Cairo' }
    })
  })

  it('replaces values whose getter throws', () => {
    const value = {
      ok: 1,
      get broken() {
        throw new Error('nope')
      }
    }
    expect(scrubValue('value', value)).toEqual({
      ok: 1,
      broken: '[Unreadable]'
    })
  })

  it('stops at cycles and deep nesting', () => {
    const cyclic: Record<string, unknown> = { name: 'a' }
    cyclic.self = cyclic
    expect(scrubValue('value', cyclic)).toEqual({
      name: 'a',
      self: '[Circular]'
    })
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }
    expect(JSON.stringify(scrubValue('value', deep))).toContain('[Truncated]')
  })
})
