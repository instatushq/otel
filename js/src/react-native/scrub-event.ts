import { FILTERED, isSensitiveKey, scrubText, scrubUrl } from '../core/scrub'

const MAX_DEPTH = 6

type ScrubbableBreadcrumb = {
  message?: string
  data?: Record<string, unknown>
}

type ScrubbableEvent = {
  message?: string
  logentry?: { message?: string; formatted?: string }
  exception?: { values?: { value?: string }[] }
  tags?: Record<string, unknown>
  extra?: Record<string, unknown>
  contexts?: Record<string, unknown>
  request?: {
    url?: string
    query_string?: unknown
    headers?: Record<string, unknown>
    cookies?: unknown
    data?: unknown
  }
  breadcrumbs?: ScrubbableBreadcrumb[]
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  Object.getPrototypeOf(value) === Object.prototype

const scrubDeep = (key: string, value: unknown, depth = 0): unknown => {
  if (isSensitiveKey(key)) return FILTERED
  if (typeof value === 'string') {
    return key === 'url' ? scrubUrl(scrubText(value)) : scrubText(value)
  }
  if (depth >= MAX_DEPTH) return '[Truncated]'
  if (Array.isArray(value)) {
    return value.map((item) => scrubDeep('', item, depth + 1))
  }
  if (!isPlainObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entry]) => [
      entryKey,
      scrubDeep(entryKey, entry, depth + 1)
    ])
  )
}

const scrubRecord = <T>(record: T): T => scrubDeep('', record) as T

export const scrubBreadcrumb = <T extends ScrubbableBreadcrumb>(
  breadcrumb: T
): T => ({
  ...breadcrumb,
  ...(breadcrumb.message && { message: scrubText(breadcrumb.message) }),
  ...(breadcrumb.data && { data: scrubRecord(breadcrumb.data) })
})

const scrubQueryString = (query: unknown) =>
  typeof query === 'string'
    ? scrubUrl(`?${query}`).slice(1)
    : scrubRecord(query)

const scrubRequest = (request: NonNullable<ScrubbableEvent['request']>) => ({
  ...request,
  ...(request.url && { url: scrubUrl(request.url) }),
  ...(request.query_string !== undefined && {
    query_string: scrubQueryString(request.query_string)
  }),
  ...(request.cookies !== undefined && { cookies: FILTERED }),
  ...(request.headers && { headers: scrubRecord(request.headers) }),
  ...(request.data !== undefined && { data: scrubRecord(request.data) })
})

const scrubLogEntry = (logentry: NonNullable<ScrubbableEvent['logentry']>) => ({
  ...logentry,
  ...(logentry.message && { message: scrubText(logentry.message) }),
  ...(logentry.formatted && { formatted: scrubText(logentry.formatted) })
})

// The same filters the browser and Node entries apply to every event.
export const scrubSentryEvent = <T extends ScrubbableEvent>(event: T): T => ({
  ...event,
  ...(event.message && { message: scrubText(event.message) }),
  ...(event.logentry && { logentry: scrubLogEntry(event.logentry) }),
  ...(event.exception?.values && {
    exception: {
      ...event.exception,
      values: event.exception.values.map((value) => ({
        ...value,
        ...(value.value && { value: scrubText(value.value) })
      }))
    }
  }),
  ...(event.tags && { tags: scrubRecord(event.tags) }),
  ...(event.extra && { extra: scrubRecord(event.extra) }),
  ...(event.contexts && { contexts: scrubRecord(event.contexts) }),
  ...(event.request && { request: scrubRequest(event.request) }),
  ...(event.breadcrumbs && {
    breadcrumbs: event.breadcrumbs.map(scrubBreadcrumb)
  })
})
