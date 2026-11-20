import { describe, expect, it } from 'vitest'
import {
  bareUrl,
  clickLabel,
  consoleMessage,
  errorFromEvent,
  errorFromRejection,
  isOpaqueScriptError
} from '../src/browser/breadcrumb-format'

const PAGE = 'https://app.example/checkout?step=2'

const element = (
  properties: Record<string, unknown>,
  attributes: Record<string, string> = {}
) => {
  const target = {
    ...properties,
    getAttribute: (name: string) => attributes[name] ?? null,
    closest: () => target
  }
  return { closest: () => target }
}

describe('clickLabel', () => {
  it('prefers the accessible name, then the visible text', () => {
    expect(
      clickLabel(
        element(
          { tagName: 'BUTTON', innerText: 'Pay' },
          { 'aria-label': 'Pay now' }
        )
      )
    ).toBe('Pay now')
    expect(
      clickLabel(element({ tagName: 'BUTTON', innerText: '  Pay \n now ' }))
    ).toBe('Pay now')
  })

  it('names submit inputs by their value', () => {
    expect(clickLabel(element({ tagName: 'INPUT', value: 'Send' }))).toBe(
      'Send'
    )
  })

  it('ignores clicks outside buttons and links', () => {
    expect(clickLabel({ closest: () => null })).toBeNull()
    expect(clickLabel(null)).toBeNull()
  })
})

describe('bareUrl', () => {
  it('keeps the path and drops the query', () => {
    expect(bareUrl('/api/pay?token=abc', PAGE)).toBe('/api/pay')
    expect(bareUrl('https://api.stripe.com/v1/charges?x=1', PAGE)).toBe(
      'https://api.stripe.com/v1/charges'
    )
  })

  it('skips the SDK’s own requests', () => {
    expect(
      bareUrl(
        'https://api.instatus.com/v1/browser/ib_x/v1/logs',
        PAGE,
        'https://api.instatus.com/v1/browser/ib_x/v1/logs'
      )
    ).toBeNull()
  })
})

describe('consoleMessage', () => {
  it('joins arguments the way the console prints them', () => {
    expect(consoleMessage(['Failed', new Error('boom'), { id: 1 }])).toBe(
      'Failed boom {"id":1}'
    )
  })
})

describe('global handler helpers', () => {
  it('builds a frame from an ErrorEvent without an error', () => {
    expect(
      errorFromEvent({
        message: 'x is not defined',
        filename: 'https://app.example/a.js',
        lineno: 3,
        colno: 9
      })
    ).toEqual({
      name: 'Error',
      message: 'x is not defined',
      stack: 'Error: x is not defined\n    at https://app.example/a.js:3:9'
    })
  })

  it('wraps non-Error rejections', () => {
    expect(errorFromRejection('nope')).toEqual({
      name: 'UnhandledRejection',
      message: 'Non-Error promise rejection captured with value: nope'
    })
    const error = new Error('real')
    expect(errorFromRejection(error)).toBe(error)
  })

  it('drops opaque cross-origin script errors', () => {
    expect(isOpaqueScriptError('Script error.')).toBe(true)
    expect(isOpaqueScriptError('Script error.', 'at x')).toBe(false)
  })
})
