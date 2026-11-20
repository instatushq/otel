import { SpanStatusCode, trace, type Span } from '@opentelemetry/api'
import { eventToLogRecord, type ErrorLogRecord } from './attributes'
import { createDedupe, markCaptured, wasCaptured } from './dedupe'
import type { RateCap } from './rate-cap'
import type { Event, EventHint, SharedOptions } from './types'

export type TraceContext = {
  traceId: string
  spanId: string
  traceFlags: number
}

export type Sink = {
  emit: (record: ErrorLogRecord, traceContext?: TraceContext) => void
  flush: (timeoutMs?: number) => Promise<boolean>
  close: (timeoutMs?: number) => Promise<boolean>
}

// Something else the client flushes and closes with its sink, such as the
// tracer provider the tracing entry adds.
export type Lifecycle = {
  flush: (timeoutMs?: number) => Promise<boolean>
  close: (timeoutMs?: number) => Promise<boolean>
}

export type ClientOptions = SharedOptions & {
  sink: Sink
  rateCap: RateCap
  enrich?: (event: Event) => Event
  sendBreadcrumbs?: boolean
}

const isThenable = <T>(value: unknown): value is PromiseLike<T> =>
  typeof (value as PromiseLike<T> | null)?.then === 'function'

const matchesPattern = (text: string, pattern: string | RegExp) =>
  typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)

const messagesOf = (event: Event) => {
  const exception = event.exception?.values[0]
  if (!exception) return [event.message ?? '']
  return [exception.value, `${exception.type}: ${exception.value}`]
}

const activeTraceContext = (
  span: Span | undefined
): TraceContext | undefined => {
  const context = span?.spanContext()
  if (!context || !trace.isSpanContextValid(context)) return undefined
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    traceFlags: context.traceFlags
  }
}

const SPAN_EVENT_KEYS = [
  'exception.type',
  'exception.message',
  'exception.stacktrace'
]
const DEFAULT_TIMEOUT_MS = 2000

// The span event is what OpenTelemetry's own recordException writes; Errors
// counts it and the log record once, since both carry this span's ids. It is
// built from the scrubbed record, so traces carry nothing the log doesn't.
const recordOnSpan = (
  span: Span | undefined,
  event: Event,
  record: ErrorLogRecord
) => {
  const exception = event.exception?.values[0]
  if (!span?.isRecording() || !exception) return
  const attributes: Record<string, string> = {}
  for (const key of SPAN_EVENT_KEYS) {
    const value = record.attributes[key]
    if (value !== undefined) attributes[key] = String(value)
  }
  span.addEvent('exception', attributes)
  if (exception.mechanism?.handled === false) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: attributes['exception.message']
    })
  }
}

// Resolves false once the deadline passes, whatever the work is still doing.
const withinDeadline = async (
  work: Promise<boolean>,
  timeoutMs: number
): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  const result = await Promise.race([work.catch(() => false), timeout])
  clearTimeout(timer)
  return result
}

export class Client {
  readonly options: ClientOptions
  private readonly isDuplicate = createDedupe()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly lifecycles: Lifecycle[] = []

  constructor(options: ClientOptions) {
    this.options = options
  }

  private log(message: string) {
    if (this.options.debug) console.warn(`[instatus] ${message}`)
  }

  private shouldDrop(event: Event, hint: EventHint) {
    if (this.options.enabled === false) return 'disabled'
    if (wasCaptured(hint.originalException)) return 'already captured'
    const sampleRate = this.options.sampleRate ?? 1
    if (sampleRate < 1 && Math.random() >= sampleRate) return 'sampled out'
    const ignored = this.options.ignoreErrors ?? []
    const messages = messagesOf(event)
    if (
      ignored.some((pattern) =>
        messages.some((text) => matchesPattern(text, pattern))
      )
    ) {
      return 'ignored'
    }
    return null
  }

  private prepare(event: Event): Event {
    const prepared = {
      ...event,
      release: event.release ?? this.options.release,
      environment: event.environment ?? this.options.environment
    }
    return this.options.enrich ? this.options.enrich(prepared) : prepared
  }

  private send(event: Event | null, span: Span | undefined) {
    if (!event) return this.log('beforeSend dropped an event')
    if (this.isDuplicate(event)) return this.log('dropped a duplicate event')
    if (!this.options.rateCap.take()) return this.log('rate cap reached')
    const record = eventToLogRecord(event, {
      breadcrumbs: this.options.sendBreadcrumbs !== false
    })
    recordOnSpan(span, event, record)
    this.options.sink.emit(record, activeTraceContext(span))
  }

  // Reporting must never throw into the app that is already handling an error.
  private safeSend(event: Event | null, span: Span | undefined) {
    try {
      this.send(event, span)
    } catch {
      this.log('could not send an event')
    }
  }

  captureEvent(event: Event, hint: EventHint = {}) {
    const dropped = this.shouldDrop(event, hint)
    if (dropped) {
      this.log(`dropped an event: ${dropped}`)
      return event.event_id
    }
    markCaptured(hint.originalException)
    const span = trace.getActiveSpan()
    const prepared = this.prepare(event)
    let result: Event | null | PromiseLike<Event | null>
    try {
      const { beforeSend } = this.options
      result = beforeSend ? beforeSend(prepared, hint) : prepared
    } catch {
      this.log('beforeSend threw')
      return event.event_id
    }
    if (isThenable<Event | null>(result)) {
      const sending = Promise.resolve(result).then(
        (resolved) => this.safeSend(resolved, span),
        () => this.log('beforeSend threw')
      )
      this.pending.add(sending)
      sending.finally(() => this.pending.delete(sending))
    } else {
      this.safeSend(result, span)
    }
    return event.event_id
  }

  addLifecycle(lifecycle: Lifecycle) {
    this.lifecycles.push(lifecycle)
  }

  // Async beforeSend callbacks finish first, so an error captured just
  // before exit is queued before the sink flushes.
  private async finish(
    timeoutMs: number,
    step: (part: Lifecycle, timeoutMs: number) => Promise<boolean>
  ) {
    const startedAt = Date.now()
    const pending = Promise.allSettled([...this.pending]).then(() => true)
    const drained = await withinDeadline(pending, timeoutMs)
    const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt))
    const parts = [this.options.sink, ...this.lifecycles]
    const results = await Promise.all(
      parts.map((part) => withinDeadline(step(part, remaining), remaining))
    )
    return drained && results.every(Boolean)
  }

  flush(timeoutMs = DEFAULT_TIMEOUT_MS) {
    return this.finish(timeoutMs, (part, remaining) => part.flush(remaining))
  }

  close(timeoutMs = DEFAULT_TIMEOUT_MS) {
    return this.finish(timeoutMs, (part, remaining) => part.close(remaining))
  }
}
