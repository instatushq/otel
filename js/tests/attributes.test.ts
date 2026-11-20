import { describe, expect, it } from 'vitest'
import { eventToLogRecord } from '../src/core/attributes'
import {
  applyScope,
  eventFromException,
  eventFromMessage
} from '../src/core/event'
import { Scope } from '../src/core/scope'

const error = () => {
  const thrown = new TypeError('Cannot read properties of undefined')
  thrown.stack =
    'TypeError: Cannot read properties of undefined\n    at checkout (app.js:1:2)'
  return thrown
}

describe('eventToLogRecord', () => {
  it('writes exceptions in the OpenTelemetry conventions', () => {
    const event = eventFromException(error(), {
      type: 'onerror',
      handled: false
    })
    const record = eventToLogRecord(event)
    expect(record.severityNumber).toBe(17)
    expect(record.severityText).toBe('ERROR')
    expect(record.body).toBe('TypeError: Cannot read properties of undefined')
    expect(record.attributes).toMatchObject({
      'exception.type': 'TypeError',
      'exception.message': 'Cannot read properties of undefined',
      'exception.stacktrace': expect.stringContaining(
        'at checkout (app.js:1:2)'
      ),
      'exception.handled': false,
      'log.record.uid': event.event_id
    })
    expect(record.timestampMs).toBe(Math.round(event.timestamp * 1000))
  })

  it('maps the scope: user to enduser.id, tags as-is, contexts and extras flattened', () => {
    const scope = new Scope()
      .setUser({
        id: 42,
        email: 'ada@example.com',
        username: 'ada',
        plan: 'pro'
      })
      .setTags({ feature: 'checkout', retries: 3 })
      .setContext('order', { id: 'o_1', total: 12.5, items: ['a'] })
      .setExtra('cart', { size: 2 })
    const record = eventToLogRecord(
      applyScope(
        eventFromException(error(), { type: 'generic', handled: true }),
        scope
      )
    )
    expect(record.attributes).toMatchObject({
      'enduser.id': '42',
      'user.id': 42,
      'user.email': 'ada@example.com',
      'user.name': 'ada',
      'user.plan': 'pro',
      feature: 'checkout',
      retries: 3,
      'order.id': 'o_1',
      'order.total': 12.5,
      'order.items': '["a"]',
      'extra.cart': '{"size":2}'
    })
  })

  it('falls back to email for enduser.id, as the Sentry intake does', () => {
    const scope = new Scope().setUser({ email: 'ada@example.com' })
    const record = eventToLogRecord(
      applyScope(eventFromMessage('hi', 'info'), scope)
    )
    expect(record.attributes['enduser.id']).toBe('ada@example.com')
  })

  it('never lets tags set instatus.* attributes', () => {
    const scope = new Scope().setTag('instatus.site_id', 'someone-else')
    const record = eventToLogRecord(
      applyScope(eventFromMessage('hi', 'info'), scope)
    )
    expect(record.attributes['instatus.site_id']).toBeUndefined()
  })

  it('scrubs sensitive keys, card numbers and URL tokens', () => {
    const scope = new Scope()
      .setTag('api_key', 'sk_live_123')
      .setExtra('password', 'hunter2')
      .setContext('payment', { note: 'card 4242 4242 4242 4242' })
    const event = {
      ...applyScope(
        eventFromException(error(), { type: 'generic', handled: true }),
        scope
      ),
      request: {
        url: 'https://app.example/cb?code=1&access_token=abc#id_token=xyz'
      }
    }
    const record = eventToLogRecord(event)
    expect(record.attributes.api_key).toBe('[Filtered]')
    expect(record.attributes['extra.password']).toBe('[Filtered]')
    expect(record.attributes['payment.note']).toBe('card [Filtered]')
    expect(record.attributes['url.full']).toBe(
      'https://app.example/cb?code=1&access_token=[Filtered]#id_token=[Filtered]'
    )
    expect(record.attributes['url.path']).toBe('/cb')
  })

  it('puts the error fields first and never lets metadata replace them', () => {
    const scope = new Scope()
      .setTag('exception.type', 'Spoofed')
      .setTags(
        Object.fromEntries(
          Array.from({ length: 80 }, (_, index) => [`t${index}`, 1])
        )
      )
    const record = eventToLogRecord(
      applyScope(
        eventFromException(error(), { type: 'generic', handled: true }),
        scope
      )
    )
    const keys = Object.keys(record.attributes)
    expect(keys.slice(0, 3)).toEqual([
      'exception.type',
      'exception.message',
      'exception.stacktrace'
    ])
    expect(record.attributes['exception.type']).toBe('TypeError')
  })

  it('filters secrets nested in extras', () => {
    const scope = new Scope().setExtra('request', {
      password: 'hunter2',
      id: 7
    })
    const record = eventToLogRecord(
      applyScope(eventFromMessage('x', 'error'), scope)
    )
    expect(record.attributes['extra.request']).toBe(
      '{"password":"[Filtered]","id":7}'
    )
  })

  it('treats error-level messages as exceptions and info messages as plain logs', () => {
    const error = eventToLogRecord(eventFromMessage('Payment failed', 'error'))
    expect(error.attributes).toMatchObject({
      'exception.type': 'Error',
      'exception.message': 'Payment failed'
    })
    const info = eventToLogRecord(eventFromMessage('Checkout started', 'info'))
    expect(info.severityText).toBe('INFO')
    expect(info.body).toBe('Checkout started')
    expect(info.attributes['exception.type']).toBeUndefined()
  })

  it('describes non-Error throwables the way Sentry does', () => {
    expect(
      eventToLogRecord(
        eventFromException('boom', { type: 'generic', handled: true })
      ).body
    ).toBe('Error: boom')
    expect(
      eventToLogRecord(
        eventFromException(
          { code: 1, reason: 'x' },
          { type: 'generic', handled: true }
        )
      ).attributes['exception.message']
    ).toBe('Object captured as exception with keys: code, reason')
  })
})

describe('applyScope', () => {
  it('lets the event override the scope', () => {
    const scope = new Scope().setTag('area', 'scope').setTag('kept', 'yes')
    const event = { ...eventFromMessage('x', 'info'), tags: { area: 'event' } }
    expect(applyScope(event, scope).tags).toEqual({
      area: 'event',
      kept: 'yes'
    })
  })
})
