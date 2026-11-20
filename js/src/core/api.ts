import {
  SpanStatusCode,
  context,
  createContextKey,
  trace,
  type Attributes,
  type Span,
  type TimeInput
} from '@opentelemetry/api'
import type { Client } from './client'
import { applyScope, eventFromException, eventFromMessage } from './event'
import { Scope } from './scope'
import { scrubText } from './scrub'
import type {
  Breadcrumb,
  BreadcrumbHint,
  CaptureContext,
  Context,
  Event,
  EventHint,
  Primitive,
  SeverityLevel,
  User
} from './types'
import { SDK_NAME, SDK_VERSION } from './version'

type Carrier = {
  client?: Client
  globalScope: Scope
  scopeStack: Scope[]
  lastEventId?: string
}

// One carrier per page or process, so the main, tracing and react entry
// points share a client even when a bundler gives each its own copy.
const CARRIER_KEY = Symbol.for('instatus.otel.carrier')
const SCOPE_KEY = createContextKey('instatus.otel.scope')

const getCarrier = (): Carrier => {
  const global = globalThis as typeof globalThis & { [CARRIER_KEY]?: Carrier }
  global[CARRIER_KEY] ??= { globalScope: new Scope(), scopeStack: [] }
  return global[CARRIER_KEY]
}

export const getClient = () => getCarrier().client

export const setClient = (client: Client | undefined) => {
  getCarrier().client = client
}

export const isInitialized = () => getClient() !== undefined

export const getGlobalScope = () => getCarrier().globalScope

// Node keeps a scope across awaits through the OpenTelemetry context; the
// browser has no async context, so a scope there lasts for the callback's
// synchronous part, as in Sentry's browser SDK.
export const getCurrentScope = (): Scope => {
  const fromContext = context.active().getValue(SCOPE_KEY)
  if (fromContext instanceof Scope) return fromContext
  const { scopeStack, globalScope } = getCarrier()
  return scopeStack[scopeStack.length - 1] ?? globalScope
}

export const getIsolationScope = getCurrentScope

export const withScope = <T>(callback: (scope: Scope) => T): T => {
  const scope = getCurrentScope().clone()
  const { scopeStack } = getCarrier()
  scopeStack.push(scope)
  try {
    return context.with(context.active().setValue(SCOPE_KEY, scope), () =>
      callback(scope)
    )
  } finally {
    scopeStack.pop()
  }
}

export const withIsolationScope = withScope

const scopeFor = (captureContext?: CaptureContext) => {
  const scope = getCurrentScope()
  if (!captureContext) return scope
  return scope.clone().update(captureContext)
}

const capture = (event: Event, hint: EventHint, scope: Scope) => {
  const client = getClient()
  if (!client) return event.event_id
  const eventId = client.captureEvent(applyScope(event, scope), hint)
  getCarrier().lastEventId = eventId
  return eventId
}

export type Mechanism = { type: string; handled: boolean }

// For the SDK's own handlers, which report how an error was caught.
export const captureWithMechanism = (
  error: unknown,
  mechanism: Mechanism,
  captureContext?: CaptureContext
) => {
  const event = eventFromException(error, mechanism)
  return capture(event, { originalException: error }, scopeFor(captureContext))
}

export const captureException = (
  error: unknown,
  captureContext?: CaptureContext
) =>
  captureWithMechanism(
    error,
    { type: 'generic', handled: true },
    captureContext
  )

export const captureMessage = (
  message: string,
  levelOrContext?: SeverityLevel | CaptureContext
) => {
  const captureContext =
    typeof levelOrContext === 'string'
      ? { level: levelOrContext }
      : levelOrContext
  const event = eventFromMessage(message, captureContext?.level ?? 'info')
  return capture(event, {}, scopeFor(captureContext))
}

export const captureEvent = (event: Event, hint: EventHint = {}) =>
  capture(event, hint, getCurrentScope())

export const lastEventId = () => getCarrier().lastEventId

export const setUser = (user: User | null) => {
  getCurrentScope().setUser(user)
  const span = trace.getActiveSpan()
  const id = user?.id ?? user?.email ?? user?.username
  if (span?.isRecording() && id !== undefined)
    span.setAttribute('enduser.id', String(id))
}

export const setTag = (key: string, value: Primitive) => {
  getCurrentScope().setTag(key, value)
}

export const setTags = (tags: Record<string, Primitive>) => {
  getCurrentScope().setTags(tags)
}

export const setContext = (name: string, value: Context | null) => {
  getCurrentScope().setContext(name, value)
}

export const setExtra = (key: string, value: unknown) => {
  getCurrentScope().setExtra(key, value)
}

export const setExtras = (extras: Record<string, unknown>) => {
  getCurrentScope().setExtras(extras)
}

export const addBreadcrumb = (
  breadcrumb: Breadcrumb,
  hint?: BreadcrumbHint
) => {
  const withTime = { timestamp: Date.now() / 1000, ...breadcrumb }
  const beforeBreadcrumb = getClient()?.options.beforeBreadcrumb
  const kept = beforeBreadcrumb ? beforeBreadcrumb(withTime, hint) : withTime
  if (kept) getCurrentScope().addBreadcrumb(kept)
}

export type StartSpanOptions = {
  name: string
  op?: string
  attributes?: Attributes
  startTime?: TimeInput
}

const tracer = () => trace.getTracer(SDK_NAME, SDK_VERSION)

const spanAttributes = ({ op, attributes }: StartSpanOptions) =>
  op ? { ...attributes, 'sentry.op': op } : attributes

const failSpan = (span: Span, error: unknown) => {
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: scrubText(String((error as Error)?.message ?? error))
  })
}

const endAfter = <T>(span: Span, run: () => T): T => {
  let result: T
  try {
    result = run()
  } catch (error) {
    failSpan(span, error)
    span.end()
    throw error
  }
  if (result instanceof Promise) {
    return result.then(
      (value) => {
        span.end()
        return value
      },
      (error: unknown) => {
        failSpan(span, error)
        span.end()
        throw error
      }
    ) as T
  }
  span.end()
  return result
}

export const startSpan = <T>(
  options: StartSpanOptions,
  callback: (span: Span) => T
): T =>
  tracer().startActiveSpan(
    options.name,
    { attributes: spanAttributes(options), startTime: options.startTime },
    (span) => endAfter(span, () => callback(span))
  )

export const startSpanManual = <T>(
  options: StartSpanOptions,
  callback: (span: Span, finish: () => void) => T
): T =>
  tracer().startActiveSpan(
    options.name,
    { attributes: spanAttributes(options), startTime: options.startTime },
    (span) => callback(span, () => span.end())
  )

export const startInactiveSpan = (options: StartSpanOptions) =>
  tracer().startSpan(options.name, {
    attributes: spanAttributes(options),
    startTime: options.startTime
  })

export const getActiveSpan = () => trace.getActiveSpan()

export const flush = async (timeoutMs?: number) =>
  (await getClient()?.flush(timeoutMs)) ?? true

export const close = async (timeoutMs?: number) => {
  const client = getClient()
  if (!client) return true
  const closed = await client.close(timeoutMs)
  setClient(undefined)
  return closed
}
