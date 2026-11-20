import { describe, expect, it } from 'vitest'
import {
  serializeBreadcrumbs,
  toInstatusBreadcrumb
} from '../src/core/breadcrumbs'
import { Scope } from '../src/core/scope'

const AT = 1_763_600_000

describe('toInstatusBreadcrumb', () => {
  it('maps the four kinds Errors shows', () => {
    expect(
      toInstatusBreadcrumb({
        category: 'ui.click',
        message: 'Pay now',
        timestamp: AT
      })
    ).toEqual({
      at: AT * 1000,
      kind: 'click',
      text: 'Pay now'
    })
    expect(
      toInstatusBreadcrumb({
        category: 'navigation',
        data: { from: '/cart', to: '/pay' },
        timestamp: AT
      })
    ).toEqual({ at: AT * 1000, kind: 'nav', from: '/cart', to: '/pay' })
    expect(
      toInstatusBreadcrumb({
        type: 'http',
        category: 'fetch',
        data: {
          method: 'post',
          url: '/api/pay',
          status_code: 500,
          duration_ms: 12.4
        },
        timestamp: AT
      })
    ).toEqual({
      at: AT * 1000,
      kind: 'request',
      method: 'POST',
      url: '/api/pay',
      status: 500,
      ms: 12
    })
    expect(
      toInstatusBreadcrumb({
        category: 'console',
        level: 'error',
        message: 'oops',
        timestamp: AT
      })
    ).toEqual({ at: AT * 1000, kind: 'console', text: 'oops' })
  })

  it('keeps loud manual breadcrumbs, labelled with their category', () => {
    expect(
      toInstatusBreadcrumb({
        category: 'auth',
        level: 'warning',
        message: 'Token expired',
        timestamp: AT
      })
    ).toEqual({ at: AT * 1000, kind: 'console', text: 'auth: Token expired' })
    expect(
      toInstatusBreadcrumb({
        category: 'auth',
        message: 'Signed in',
        timestamp: AT
      })
    ).toBeNull()
  })

  it('cuts long text to what the backend keeps', () => {
    const crumb = toInstatusBreadcrumb({
      category: 'ui.click',
      message: 'x'.repeat(100),
      timestamp: AT
    })
    expect(crumb).toMatchObject({ text: 'x'.repeat(40) })
  })

  it('drops breadcrumbs it cannot place', () => {
    expect(
      toInstatusBreadcrumb({ category: 'ui.click', message: 'x' })
    ).toBeNull()
    expect(
      toInstatusBreadcrumb({ type: 'http', data: {}, timestamp: AT })
    ).toBeNull()
    expect(
      toInstatusBreadcrumb({
        category: 'console',
        level: 'error',
        timestamp: AT
      })
    ).toBeNull()
  })
})

describe('serializeBreadcrumbs', () => {
  it('writes the JSON the instatus.breadcrumbs attribute holds', () => {
    expect(serializeBreadcrumbs([])).toBeUndefined()
    expect(
      JSON.parse(
        serializeBreadcrumbs([
          { category: 'ui.click', message: 'Go', timestamp: AT }
        ])!
      )
    ).toEqual([{ at: AT * 1000, kind: 'click', text: 'Go' }])
  })
})

describe('Scope breadcrumbs', () => {
  it('keeps the newest maxBreadcrumbs', () => {
    const scope = new Scope()
    scope.maxBreadcrumbs = 3
    for (let index = 0; index < 5; index += 1)
      scope.addBreadcrumb({ message: String(index) })
    expect(scope.breadcrumbs.map((crumb) => crumb.message)).toEqual([
      '2',
      '3',
      '4'
    ])
  })

  it('clones independently', () => {
    const scope = new Scope().setTag('a', 1)
    const copy = scope.clone().setTag('b', 2)
    expect(scope.tags).toEqual({ a: 1 })
    expect(copy.tags).toEqual({ a: 1, b: 2 })
  })
})
