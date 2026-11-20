import { describe, expect, it } from 'vitest'
import {
  scrubbedBeforeBreadcrumb,
  scrubbedBeforeSend
} from '../src/react-native/options'
import { scrubSentryEvent } from '../src/react-native/scrub-event'

const CARD = '4242 4242 4242 4242'

describe('scrubSentryEvent', () => {
  it('filters secrets and card numbers like the other entries', () => {
    const event = scrubSentryEvent({
      message: `Charge failed for ${CARD}`,
      exception: { values: [{ type: 'Error', value: `card ${CARD}` }] },
      tags: { plan: 'pro', authToken: 'abc' },
      extra: { order: { id: 7, password: 'hunter2' } },
      contexts: { checkout: { apiKey: 'k', items: 3 } },
      request: {
        url: 'https://user:pw@api.acme.com/pay?token=t&step=2',
        query_string: 'token=t&step=2',
        headers: { Authorization: 'Bearer x', Accept: 'json' },
        cookies: 'sid=1'
      },
      breadcrumbs: [
        {
          message: `typed ${CARD}`,
          data: { url: 'https://api.acme.com/?secret=s', status: 500 }
        }
      ]
    })

    expect(event.message).toBe('Charge failed for [Filtered]')
    expect(event.exception?.values?.[0].value).toBe('card [Filtered]')
    expect(event.tags).toEqual({ plan: 'pro', authToken: '[Filtered]' })
    expect(event.extra).toEqual({ order: { id: 7, password: '[Filtered]' } })
    expect(event.contexts).toEqual({
      checkout: { apiKey: '[Filtered]', items: 3 }
    })
    expect(event.request).toEqual({
      url: 'https://api.acme.com/pay?token=[Filtered]&step=2',
      query_string: 'token=[Filtered]&step=2',
      headers: { Authorization: '[Filtered]', Accept: 'json' },
      cookies: '[Filtered]'
    })
    expect(event.breadcrumbs?.[0]).toEqual({
      message: 'typed [Filtered]',
      data: { url: 'https://api.acme.com/?secret=[Filtered]', status: 500 }
    })
  })

  it('filters card numbers in log entries', () => {
    const scrubbed = scrubSentryEvent({
      logentry: {
        message: 'card %s',
        formatted: 'card 4242 4242 4242 4242'
      }
    })
    expect(scrubbed.logentry).toEqual({
      message: 'card %s',
      formatted: 'card [Filtered]'
    })
  })

  it('cuts nested values past the depth limit instead of passing them on', () => {
    const deep = {
      a: { b: { c: { d: { e: { f: { password: 'hunter2' } } } } } }
    }
    expect(JSON.stringify(scrubSentryEvent({ extra: deep }))).not.toContain(
      'hunter2'
    )
  })

  it('leaves order numbers and timestamps of card length alone', () => {
    expect(scrubSentryEvent({ message: 'order 1234567890123' }).message).toBe(
      'order 1234567890123'
    )
  })
})

describe('scrubbedBeforeSend', () => {
  const event = { type: undefined, message: `paid with ${CARD}` }
  const hint = {}

  it('filters events when the app has no hook', () => {
    expect(scrubbedBeforeSend()(event, hint)).toMatchObject({
      message: 'paid with [Filtered]'
    })
  })

  it('filters what the app’s hook returns, sync or async', async () => {
    const tagged = scrubbedBeforeSend((sent) => ({
      ...sent,
      extra: { token: 't' }
    }))(event, hint)
    expect(tagged).toMatchObject({ extra: { token: '[Filtered]' } })

    const later = await scrubbedBeforeSend(async (sent) => sent)(event, hint)
    expect(later).toMatchObject({ message: 'paid with [Filtered]' })
  })

  it('keeps a dropped event dropped', () => {
    expect(scrubbedBeforeSend(() => null)(event, hint)).toBeNull()
  })
})

describe('scrubbedBeforeBreadcrumb', () => {
  it('filters breadcrumbs after the app’s hook', () => {
    const keep = scrubbedBeforeBreadcrumb((breadcrumb) => breadcrumb)
    expect(keep({ message: CARD })).toEqual({ message: '[Filtered]' })
    expect(scrubbedBeforeBreadcrumb(() => null)({ message: 'x' })).toBeNull()
  })
})
