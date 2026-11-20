import type { AttributeValue, Attributes, ErrorLogRecord } from './attributes'
import type { TraceContext } from './client'

type AnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: number }
  | { doubleValue: number }

export type EncodedRecord = {
  record: ErrorLogRecord
  traceContext?: TraceContext
}

const anyValue = (value: AttributeValue): AnyValue => {
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { intValue: value }
      : { doubleValue: value }
  }
  return { stringValue: value }
}

const keyValues = (attributes: Attributes) =>
  Object.entries(attributes).map(([key, value]) => ({
    key,
    value: anyValue(value)
  }))

const unixNano = (ms: number) => `${Math.max(0, Math.round(ms))}000000`

const logRecord = ({ record, traceContext }: EncodedRecord) => {
  const encoded = {
    timeUnixNano: unixNano(record.timestampMs),
    observedTimeUnixNano: unixNano(Date.now()),
    severityNumber: record.severityNumber,
    severityText: record.severityText,
    body: { stringValue: record.body },
    attributes: keyValues(record.attributes)
  }
  if (!traceContext) return encoded
  return {
    ...encoded,
    traceId: traceContext.traceId,
    spanId: traceContext.spanId,
    flags: traceContext.traceFlags
  }
}

// OTLP/JSON ExportLogsServiceRequest, written by hand so the errors-only
// browser bundle doesn't carry the logs SDK and its protobuf transformer.
export const encodeLogsRequest = (
  resource: Attributes,
  scope: { name: string; version: string },
  records: EncodedRecord[]
) =>
  JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: keyValues(resource) },
        scopeLogs: [{ scope, logRecords: records.map(logRecord) }]
      }
    ]
  })
