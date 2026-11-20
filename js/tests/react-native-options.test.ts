import { describe, expect, it } from 'vitest'
import {
  supportedIntegrations,
  toSentryOptions
} from '../src/react-native/options'

const SENTRY_KEY = Buffer.from(
  'AbCdEfGhIjKlMnOpQrStUvWx',
  'base64url'
).toString('hex')
const DSN = `https://${SENTRY_KEY}@api.instatus.com/sentry/1`

const integration = (name: string) => ({ name, setupOnce: () => {} })
const names = (list: { name: string }[]) => list.map((entry) => entry.name)

describe('toSentryOptions', () => {
  it('passes the Instatus DSN and the app’s options to Sentry', () => {
    const options = toSentryOptions({
      dsn: DSN,
      release: 'com.acme.shop@2.4.0+118',
      environment: 'production',
      enableNative: true
    })
    expect(options).toMatchObject({
      dsn: DSN,
      release: 'com.acme.shop@2.4.0+118',
      environment: 'production',
      enableNative: true
    })
  })

  it('turns off what the intake drops, unless the app asks', () => {
    expect(toSentryOptions({ dsn: DSN })).toMatchObject({
      enableAutoSessionTracking: false,
      attachScreenshot: false,
      attachViewHierarchy: false
    })
    expect(
      toSentryOptions({ dsn: DSN, attachScreenshot: true })?.attachScreenshot
    ).toBe(true)
  })

  it('drops replay and profiling sample rates', () => {
    const options = toSentryOptions({
      dsn: DSN,
      ...({
        replaysSessionSampleRate: 1,
        replaysOnErrorSampleRate: 1,
        profilesSampleRate: 1
      } as object)
    })
    expect(options).not.toHaveProperty('replaysSessionSampleRate')
    expect(options).not.toHaveProperty('replaysOnErrorSampleRate')
    expect(options).not.toHaveProperty('profilesSampleRate')
  })

  it('keeps serviceName out of Sentry’s options', () => {
    expect(
      toSentryOptions({ dsn: DSN, serviceName: 'shop' })
    ).not.toHaveProperty('serviceName')
  })

  it('refuses a DSN that is not an Instatus one', () => {
    expect(
      toSentryOptions({ dsn: 'https://abc123@o1.ingest.sentry.io/42' })
    ).toBeNull()
    expect(toSentryOptions({ dsn: '' })).toBeNull()
  })
})

describe('supportedIntegrations', () => {
  const defaults = [
    integration('ReactNativeErrorHandlers'),
    integration('MobileReplay'),
    integration('HermesProfiling')
  ]

  it('removes replay and profiling from the defaults', () => {
    expect(names(supportedIntegrations(undefined)(defaults))).toEqual([
      'ReactNativeErrorHandlers'
    ])
  })

  it('adds the app’s integrations, minus replay and feedback', () => {
    const resolved = supportedIntegrations([
      integration('ReactNavigation'),
      integration('MobileFeedback')
    ])(defaults)
    expect(names(resolved)).toEqual([
      'ReactNativeErrorHandlers',
      'ReactNavigation'
    ])
  })

  it('filters what an integrations function returns', () => {
    const resolved = supportedIntegrations((all) => [
      ...all,
      integration('ShakeToReport')
    ])(defaults)
    expect(names(resolved)).toEqual(['ReactNativeErrorHandlers'])
  })
})
