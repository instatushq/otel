import type { Scope } from './scope'
import type { Event, ExceptionValue, SeverityLevel } from './types'

const MAX_KEYS_IN_MESSAGE = 10

const randomHex = (bytes: number) => {
  const values = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(values)
  return Array.from(values, (value) =>
    value.toString(16).padStart(2, '0')
  ).join('')
}

export const generateEventId = () => randomHex(16)

const isErrorLike = (value: unknown): value is Error =>
  value instanceof Error ||
  (typeof value === 'object' &&
    value !== null &&
    typeof (value as Error).message === 'string' &&
    (typeof (value as Error).stack === 'string' ||
      typeof (value as Error).name === 'string'))

const constructorName = (value: object) => {
  const name = Object.getPrototypeOf(value)?.constructor?.name
  return typeof name === 'string' && name !== 'Object' ? name : 'Error'
}

const describeObject = (value: object) => {
  const keys = Object.keys(value).sort().slice(0, MAX_KEYS_IN_MESSAGE)
  return `Object captured as exception with keys: ${keys.join(', ') || '[none]'}`
}

export const exceptionFromUnknown = (error: unknown): ExceptionValue => {
  if (isErrorLike(error)) {
    return {
      type: error.name || 'Error',
      value: String(error.message),
      stacktrace: typeof error.stack === 'string' ? error.stack : undefined
    }
  }
  if (typeof error === 'object' && error !== null) {
    return { type: constructorName(error), value: describeObject(error) }
  }
  return { type: 'Error', value: String(error) }
}

const nowSeconds = () => Date.now() / 1000

const emptyEvent = (level: SeverityLevel): Event => ({
  event_id: generateEventId(),
  timestamp: nowSeconds(),
  level,
  tags: {},
  extra: {},
  contexts: {},
  breadcrumbs: []
})

export const eventFromException = (
  error: unknown,
  mechanism: { type: string; handled: boolean }
): Event => ({
  ...emptyEvent('error'),
  exception: { values: [{ ...exceptionFromUnknown(error), mechanism }] }
})

export const eventFromMessage = (
  message: string,
  level: SeverityLevel
): Event => ({
  ...emptyEvent(level),
  message
})

// Event values win over the scope's, like Sentry: captureException(error, { tags }) beats setTag.
export const applyScope = (event: Event, scope: Scope): Event => ({
  ...event,
  level: scope.level ?? event.level,
  user: event.user ?? scope.user,
  tags: { ...scope.tags, ...event.tags },
  extra: { ...scope.extra, ...event.extra },
  contexts: { ...scope.contexts, ...event.contexts },
  breadcrumbs: [...scope.breadcrumbs, ...event.breadcrumbs]
})
