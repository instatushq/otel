import { describe, expect, it } from 'vitest'
import { resolveIntegrations, type Integration } from '../src/core/integrations'

const named = (name: string): Integration => ({ name, setup: () => undefined })
const defaults = () => [named('GlobalHandlers'), named('Breadcrumbs')]
const names = (integrations: Integration[]) =>
  integrations.map((integration) => integration.name)

describe('resolveIntegrations', () => {
  it('uses the defaults', () => {
    expect(names(resolveIntegrations({}, defaults))).toEqual([
      'GlobalHandlers',
      'Breadcrumbs'
    ])
  })

  it('replaces a default with a configured one of the same name', () => {
    const custom = named('Breadcrumbs')
    const resolved = resolveIntegrations(
      { integrations: [custom, named('Extra')] },
      defaults
    )
    expect(names(resolved)).toEqual(['GlobalHandlers', 'Breadcrumbs', 'Extra'])
    expect(resolved[1]).toBe(custom)
  })

  it('turns the defaults off', () => {
    expect(
      names(resolveIntegrations({ defaultIntegrations: false }, defaults))
    ).toEqual([])
  })

  it('passes the defaults to a function', () => {
    const resolved = resolveIntegrations(
      {
        integrations: (all) =>
          all.filter((integration) => integration.name !== 'Breadcrumbs')
      },
      defaults
    )
    expect(names(resolved)).toEqual(['GlobalHandlers'])
  })
})
