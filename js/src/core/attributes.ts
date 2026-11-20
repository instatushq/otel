import { BREADCRUMBS_ATTRIBUTE, serializeBreadcrumbs } from './breadcrumbs'
import { scrubText, scrubUrl, scrubValue } from './scrub'
import type { Breadcrumb, Event, SeverityLevel, User } from './types'

export type AttributeValue = string | number | boolean
export type Attributes = Record<string, AttributeValue>

export type ErrorLogRecord = {
  timestampMs: number
  severityNumber: number
  severityText: string
  body: string
  attributes: Attributes
}

const SEVERITY: Record<SeverityLevel, { number: number; text: string }> = {
  fatal: { number: 21, text: 'FATAL' },
  error: { number: 17, text: 'ERROR' },
  warning: { number: 13, text: 'WARN' },
  log: { number: 9, text: 'INFO' },
  info: { number: 9, text: 'INFO' },
  debug: { number: 5, text: 'DEBUG' }
}

const RESERVED_PREFIX = 'instatus.'
const MAX_VALUE_LENGTH = 8192
const MAX_STACK_LENGTH = 32_000
const DEFAULT_EXCEPTION_TYPE = 'Error'
const USER_KEYS: Record<string, string> = {
  username: 'name',
  ip_address: 'ip'
}

const stringify = (value: unknown) => {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export const toAttributeValue = (
  value: unknown
): AttributeValue | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value.slice(0, MAX_VALUE_LENGTH)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint' || typeof value === 'symbol')
    return String(value)
  return stringify(value).slice(0, MAX_VALUE_LENGTH)
}

const put = (attributes: Attributes, key: string, value: unknown) => {
  if (key.startsWith(RESERVED_PREFIX)) return
  const attribute = toAttributeValue(scrubValue(key, value))
  if (attribute !== undefined && attribute !== '') attributes[key] = attribute
}

const userAttributes = (user: User | undefined) => {
  const attributes: Attributes = {}
  if (!user) return attributes
  const endUser = user.id ?? user.email ?? user.username
  if (endUser !== undefined && endUser !== '') {
    attributes['enduser.id'] = String(endUser)
  }
  for (const [key, value] of Object.entries(user)) {
    put(attributes, `user.${USER_KEYS[key] ?? key}`, value)
  }
  return attributes
}

const flattenContexts = (
  attributes: Attributes,
  contexts: Event['contexts']
) => {
  for (const [name, context] of Object.entries(contexts)) {
    if (typeof context !== 'object' || context === null) {
      put(attributes, name, context)
      continue
    }
    for (const [key, value] of Object.entries(context))
      put(attributes, `${name}.${key}`, value)
  }
}

const metadataOf = (event: Event) => {
  const metadata: Attributes = {}
  for (const [key, value] of Object.entries(event.tags)) {
    put(metadata, key, value)
  }
  flattenContexts(metadata, event.contexts)
  for (const [key, value] of Object.entries(event.extra)) {
    put(metadata, `extra.${key}`, value)
  }
  return { ...metadata, ...userAttributes(event.user) }
}

const pathOf = (url: string) => {
  try {
    return new URL(url).pathname
  } catch {
    return undefined
  }
}

const scrubDataValue = (key: string, value: unknown) => {
  if (key === 'url' && typeof value === 'string') return scrubUrl(value)
  return scrubValue(key, value)
}

const scrubBreadcrumb = (breadcrumb: Breadcrumb): Breadcrumb => {
  const data: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(breadcrumb.data ?? {})) {
    data[key] = scrubDataValue(key, value)
  }
  const scrubbed = { ...breadcrumb, data }
  if (breadcrumb.message) scrubbed.message = scrubText(breadcrumb.message)
  return scrubbed
}

const headlineOf = (type: string, message: string) =>
  message ? `${type}: ${message}` : type

const exceptionAttributes = (event: Event, isError: boolean) => {
  const attributes: Attributes = {}
  const exception = event.exception?.values[0]
  if (exception) {
    attributes['exception.type'] = exception.type || DEFAULT_EXCEPTION_TYPE
    attributes['exception.message'] = scrubText(exception.value).slice(
      0,
      MAX_VALUE_LENGTH
    )
    if (exception.stacktrace) {
      attributes['exception.stacktrace'] = scrubText(
        exception.stacktrace
      ).slice(0, MAX_STACK_LENGTH)
    }
    if (exception.mechanism)
      attributes['exception.handled'] = exception.mechanism.handled
    return attributes
  }
  if (isError && event.message) {
    attributes['exception.type'] = DEFAULT_EXCEPTION_TYPE
    attributes['exception.message'] = scrubText(event.message).slice(
      0,
      MAX_VALUE_LENGTH
    )
  }
  return attributes
}

const bodyOf = (event: Event) => {
  const exception = event.exception?.values[0]
  if (exception) {
    return headlineOf(
      exception.type || DEFAULT_EXCEPTION_TYPE,
      scrubText(exception.value)
    )
  }
  return scrubText(event.message ?? '')
}

// Sentry tags, contexts and extras become log attributes, and errors follow
// the OpenTelemetry exception conventions so Instatus Errors groups them.
export const eventToLogRecord = (
  event: Event,
  { breadcrumbs: withBreadcrumbs = true } = {}
): ErrorLogRecord => {
  const severity = SEVERITY[event.level] ?? SEVERITY.error
  const isError = severity.number >= SEVERITY.error.number
  const attributes: Attributes = {
    ...exceptionAttributes(event, isError),
    'log.record.uid': event.event_id
  }

  const url = event.request?.url ? scrubUrl(event.request.url) : undefined
  if (url) {
    attributes['url.full'] = url.slice(0, MAX_VALUE_LENGTH)
    const path = pathOf(url)
    if (path) attributes['url.path'] = path
  }
  const breadcrumbs = withBreadcrumbs
    ? serializeBreadcrumbs(event.breadcrumbs.map(scrubBreadcrumb))
    : undefined
  if (breadcrumbs) attributes[BREADCRUMBS_ATTRIBUTE] = breadcrumbs

  // The error's own fields come first and win: receivers cap attribute
  // counts, and metadata must never push the exception out.
  for (const [key, value] of Object.entries(metadataOf(event))) {
    if (!(key in attributes)) attributes[key] = value
  }

  return {
    timestampMs: Math.round(event.timestamp * 1000),
    severityNumber: severity.number,
    severityText: severity.text,
    body: bodyOf(event),
    attributes
  }
}
