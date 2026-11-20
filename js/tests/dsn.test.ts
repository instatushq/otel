import { describe, expect, it } from 'vitest'
import {
  browserKeyFromSentryKey,
  browserLogsUrl,
  parseDsn
} from '../src/core/dsn'
import { resolvePublicLogsUrl } from '../src/core/endpoints'

const BROWSER_KEY = 'ib_AbCdEfGhIjKlMnOpQrStUvWx'
const SENTRY_KEY = Buffer.from(BROWSER_KEY.slice(3), 'base64url').toString(
  'hex'
)

describe('browserKeyFromSentryKey', () => {
  it('turns the hex DSN key back into the browser key, like the backend', () => {
    expect(browserKeyFromSentryKey(SENTRY_KEY)).toBe(BROWSER_KEY)
    expect(browserKeyFromSentryKey(SENTRY_KEY.toUpperCase())).toBe(BROWSER_KEY)
  })

  it('round-trips keys that use - and _', () => {
    const key = 'ib_-_-_abcdefghijklmnopqr-_'
    const hex = Buffer.from(key.slice(3), 'base64url').toString('hex')
    expect(browserKeyFromSentryKey(hex)).toBe(key)
  })

  it('refuses keys that are not 18 bytes of hex', () => {
    expect(browserKeyFromSentryKey('abc')).toBeNull()
    expect(browserKeyFromSentryKey(`${SENTRY_KEY.slice(0, 35)}z`)).toBeNull()
  })
})

describe('parseDsn', () => {
  it('reads the Instatus Sentry-format DSN', () => {
    expect(parseDsn(`https://${SENTRY_KEY}@api.instatus.com/sentry/1`)).toEqual(
      {
        origin: 'https://api.instatus.com',
        publicKey: SENTRY_KEY,
        browserKey: BROWSER_KEY,
        projectId: '1'
      }
    )
  })

  it('keeps a local port', () => {
    expect(
      parseDsn(`http://${SENTRY_KEY}@localhost:1111/sentry/1`)?.origin
    ).toBe('http://localhost:1111')
  })

  it('refuses DSNs it cannot use', () => {
    expect(parseDsn('not a url')).toBeNull()
    expect(parseDsn('https://api.instatus.com/sentry/1')).toBeNull()
    expect(parseDsn(`https://${SENTRY_KEY}@api.instatus.com`)).toBeNull()
    expect(parseDsn(`ftp://${SENTRY_KEY}@api.instatus.com/1`)).toBeNull()
  })
})

describe('resolvePublicLogsUrl', () => {
  it('posts DSN errors to the browser key intake on the DSN host', () => {
    expect(
      resolvePublicLogsUrl({
        dsn: `https://${SENTRY_KEY}@api.instatus.com/sentry/1`
      })
    ).toBe(`https://api.instatus.com/v1/browser/${BROWSER_KEY}/v1/logs`)
  })

  it('takes a browser key on its own', () => {
    expect(resolvePublicLogsUrl({ browserKey: BROWSER_KEY })).toBe(
      browserLogsUrl('https://api.instatus.com', BROWSER_KEY)
    )
    expect(resolvePublicLogsUrl({ browserKey: 'nope' })).toBeNull()
  })

  it('prefers an explicit OTLP logs endpoint', () => {
    expect(
      resolvePublicLogsUrl({
        logsEndpoint: 'https://collector.example/v1/logs',
        browserKey: BROWSER_KEY
      })
    ).toBe('https://collector.example/v1/logs')
  })
})
