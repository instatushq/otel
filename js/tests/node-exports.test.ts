import { describe, expect, it } from 'vitest'
import { resolveNodeExports } from '../src/node/exports'

const SENTRY_KEY = Buffer.from(
  'AbCdEfGhIjKlMnOpQrStUvWx',
  'base64url'
).toString('hex')

describe('resolveNodeExports', () => {
  it('sends every signal to otel.instatus.com with an API key', () => {
    const exports = resolveNodeExports(
      { apiKey: 'inst_sk_1', siteId: 'site_1' },
      {}
    )
    expect(exports.traces).toEqual({
      url: 'https://otel.instatus.com/v1/traces',
      headers: {
        Authorization: 'Bearer inst_sk_1',
        'X-Instatus-Site-Id': 'site_1'
      }
    })
    expect(exports.logs?.url).toBe('https://otel.instatus.com/v1/logs')
    expect(exports.metrics?.url).toBe('https://otel.instatus.com/v1/metrics')
  })

  it('reads the key and site from the environment', () => {
    const exports = resolveNodeExports(
      {},
      { INSTATUS_API_KEY: 'k', INSTATUS_SITE_ID: 's' }
    )
    expect(exports.logs?.headers).toEqual({
      Authorization: 'Bearer k',
      'X-Instatus-Site-Id': 's'
    })
  })

  it('leaves the URL to OTEL_EXPORTER_OTLP_* when set', () => {
    const exports = resolveNodeExports(
      { apiKey: 'k' },
      { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://localhost:4318/v1/traces' }
    )
    expect(exports.traces?.url).toBeUndefined()
    expect(exports.logs?.url).toBe('https://otel.instatus.com/v1/logs')
  })

  it('lets an explicit endpoint win over the environment', () => {
    const exports = resolveNodeExports(
      { apiKey: 'k', endpoint: 'http://localhost:4318/' },
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://elsewhere:4318' }
    )
    expect(exports.logs?.url).toBe('http://localhost:4318/v1/logs')
  })

  it('works as a plain OTel distro with only OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    const exports = resolveNodeExports(
      {},
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' }
    )
    expect(exports.logs).toEqual({ headers: {} })
    expect(exports.traces).toEqual({ headers: {} })
  })

  it('reports only errors, through the public intake, with just a DSN', () => {
    const exports = resolveNodeExports(
      { dsn: `https://${SENTRY_KEY}@api.instatus.com/sentry/1` },
      {}
    )
    expect(exports).toEqual({
      logs: {
        url: 'https://api.instatus.com/v1/browser/ib_AbCdEfGhIjKlMnOpQrStUvWx/v1/logs',
        headers: {},
        isPublic: true
      }
    })
  })

  it('enables each signal that has its own OTEL endpoint', () => {
    const exports = resolveNodeExports(
      { dsn: `https://${SENTRY_KEY}@api.instatus.com/sentry/1` },
      { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://localhost:4318/v1/traces' }
    )
    expect(exports.traces).toEqual({ headers: {} })
    expect(exports.logs?.url).toBe(
      'https://api.instatus.com/v1/browser/ib_AbCdEfGhIjKlMnOpQrStUvWx/v1/logs'
    )
    expect(exports.metrics).toBeUndefined()
    expect(
      resolveNodeExports(
        {},
        { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://x/v1/logs' }
      ).logs
    ).toEqual({ headers: {} })
  })

  it('has nowhere to send without credentials', () => {
    expect(resolveNodeExports({}, {})).toEqual({})
  })
})
