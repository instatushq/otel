import type { Attributes, ErrorLogRecord } from '../core/attributes'
import { BREADCRUMBS_ATTRIBUTE } from '../core/breadcrumbs'
import type { Sink, TraceContext } from '../core/client'
import { encodeLogsRequest, type EncodedRecord } from '../core/otlp-json'
import { SDK_NAME, SDK_VERSION } from '../core/version'

// keepalive and sendBeacon refuse bodies past 64 KB, counted in bytes.
export const MAX_BODY_BYTES = 60_000
const MAX_BATCH = 10
const FLUSH_DELAY_MS = 1000

const encoder = new TextEncoder()
const byteSize = (text: string) => encoder.encode(text).length

const withoutBreadcrumbs = (record: ErrorLogRecord): ErrorLogRecord => {
  const attributes = { ...record.attributes }
  delete attributes[BREADCRUMBS_ATTRIBUTE]
  return { ...record, attributes }
}

const withShorterStack = (record: ErrorLogRecord): ErrorLogRecord | null => {
  const stack = record.attributes['exception.stacktrace']
  if (typeof stack !== 'string' || stack.length === 0) return null
  const attributes = { ...record.attributes }
  attributes['exception.stacktrace'] = stack.slice(
    0,
    Math.floor(stack.length / 2)
  )
  return { ...record, attributes }
}

// Breadcrumbs go first, then the stack is halved until the body fits.
export const fitRecord = (
  entry: EncodedRecord,
  encode: (records: EncodedRecord[]) => string,
  maxBytes = MAX_BODY_BYTES
): string | null => {
  let current: EncodedRecord = entry
  let body = encode([current])
  if (byteSize(body) <= maxBytes) return body
  current = { ...current, record: withoutBreadcrumbs(current.record) }
  body = encode([current])
  while (byteSize(body) > maxBytes) {
    const shorter = withShorterStack(current.record)
    if (!shorter) return null
    current = { ...current, record: shorter }
    body = encode([current])
  }
  return body
}

export const batchBodies = (
  entries: EncodedRecord[],
  encode: (records: EncodedRecord[]) => string,
  maxBytes = MAX_BODY_BYTES
) => {
  const bodies: string[] = []
  for (let start = 0; start < entries.length; start += MAX_BATCH) {
    const batch = entries.slice(start, start + MAX_BATCH)
    const body = encode(batch)
    if (byteSize(body) <= maxBytes) {
      bodies.push(body)
      continue
    }
    for (const entry of batch) {
      const fitted = fitRecord(entry, encode, maxBytes)
      if (fitted) bodies.push(fitted)
    }
  }
  return bodies
}

export type BrowserTransportOptions = {
  url: string
  resource: Attributes
  headers?: Record<string, string>
}

// text/plain keeps the POST a simple CORS request, so no preflight runs.
// Custom headers need one anyway, so those requests send application/json.
export const createBrowserTransport = ({
  url,
  resource,
  headers
}: BrowserTransportOptions): Sink => {
  const scope = { name: SDK_NAME, version: SDK_VERSION }
  const encode = (records: EncodedRecord[]) =>
    encodeLogsRequest(resource, scope, records)
  const hasHeaders = !!headers && Object.keys(headers).length > 0
  const contentType = hasHeaders ? 'application/json' : 'text/plain'
  let queue: EncodedRecord[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = new Set<Promise<unknown>>()

  const post = (body: string) => {
    const request = fetch(url, {
      method: 'POST',
      body,
      keepalive: true,
      headers: { 'Content-Type': contentType, ...headers }
    }).catch(() => undefined)
    pending.add(request)
    request.finally(() => pending.delete(request))
  }

  const drain = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    const entries = queue
    queue = []
    return batchBodies(entries, encode)
  }

  const send = () => drain().forEach(post)

  const beacon = () => {
    const bodies = drain()
    for (const body of bodies) {
      if (hasHeaders || !navigator.sendBeacon?.(url, body)) post(body)
    }
  }

  const onHidden = () => {
    if (document.visibilityState === 'hidden') beacon()
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onHidden)
    addEventListener('pagehide', beacon)
  }

  const flush = async (timeoutMs = 2000) => {
    send()
    const settled = Promise.allSettled([...pending]).then(() => true)
    const timeout = new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), timeoutMs)
    )
    return Promise.race([settled, timeout])
  }

  return {
    emit: (record: ErrorLogRecord, traceContext?: TraceContext) => {
      queue.push({ record, traceContext })
      if (queue.length >= MAX_BATCH) send()
      else timer ??= setTimeout(send, FLUSH_DELAY_MS)
    },
    flush,
    close: async (timeoutMs?: number) => {
      const flushed = await flush(timeoutMs)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onHidden)
        removeEventListener('pagehide', beacon)
      }
      return flushed
    }
  }
}
