import { describe, expect, it } from 'vitest'
import { batchBodies, fitRecord } from '../src/browser/transport'
import type { ErrorLogRecord } from '../src/core/attributes'
import { encodeLogsRequest, type EncodedRecord } from '../src/core/otlp-json'

const encode = (records: EncodedRecord[]) =>
  encodeLogsRequest(
    { 'service.name': 'web' },
    { name: '@instatus/otel', version: '0.1.0' },
    records
  )

const record = (
  attributes: ErrorLogRecord['attributes'] = {}
): ErrorLogRecord => ({
  timestampMs: 1_763_600_000_123,
  severityNumber: 17,
  severityText: 'ERROR',
  body: 'TypeError: x',
  attributes: { 'exception.type': 'TypeError', ...attributes }
})

describe('encodeLogsRequest', () => {
  it('writes an OTLP/JSON ExportLogsServiceRequest', () => {
    const body = JSON.parse(
      encode([
        {
          record: record({ handled: false, count: 2, ratio: 0.5 }),
          traceContext: {
            traceId: 'a'.repeat(32),
            spanId: 'b'.repeat(16),
            traceFlags: 1
          }
        }
      ])
    )
    const [resourceLogs] = body.resourceLogs
    expect(resourceLogs.resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'web' } }
    ])
    const [logRecord] = resourceLogs.scopeLogs[0].logRecords
    expect(logRecord).toMatchObject({
      timeUnixNano: '1763600000123000000',
      severityNumber: 17,
      severityText: 'ERROR',
      body: { stringValue: 'TypeError: x' },
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      flags: 1
    })
    expect(logRecord.attributes).toContainEqual({
      key: 'handled',
      value: { boolValue: false }
    })
    expect(logRecord.attributes).toContainEqual({
      key: 'count',
      value: { intValue: 2 }
    })
    expect(logRecord.attributes).toContainEqual({
      key: 'ratio',
      value: { doubleValue: 0.5 }
    })
  })

  it('leaves trace ids out when no span was active', () => {
    const body = JSON.parse(encode([{ record: record() }]))
    expect(
      body.resourceLogs[0].scopeLogs[0].logRecords[0].traceId
    ).toBeUndefined()
  })
})

describe('fitRecord', () => {
  it('drops breadcrumbs, then halves the stack, to fit the beacon limit', () => {
    const big = record({
      'exception.stacktrace': 's'.repeat(3000),
      'instatus.breadcrumbs': 'b'.repeat(3000)
    })
    const body = fitRecord({ record: big }, encode, 2000)!
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(2000)
    expect(body).not.toContain('instatus.breadcrumbs')
    expect(body).toContain('exception.stacktrace')
  })

  it('gives up on a record that cannot fit', () => {
    expect(
      fitRecord(
        { record: record({ 'exception.message': 'm'.repeat(5000) }) },
        encode,
        2000
      )
    ).toBeNull()
  })
})

describe('batchBodies', () => {
  it('sends up to ten records per request', () => {
    const entries = Array.from({ length: 12 }, () => ({ record: record() }))
    expect(batchBodies(entries, encode)).toHaveLength(2)
  })

  it('splits a batch that is too big into single records', () => {
    const entries = Array.from({ length: 3 }, () => ({
      record: record({ 'exception.stacktrace': 's'.repeat(900) })
    }))
    expect(batchBodies(entries, encode, 2000)).toHaveLength(3)
  })
})
