export type SeverityLevel =
  | 'fatal'
  | 'error'
  | 'warning'
  | 'log'
  | 'info'
  | 'debug'

export type Primitive =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined

export type User = {
  id?: string | number
  email?: string
  username?: string
  ip_address?: string
  [key: string]: unknown
}

export type Breadcrumb = {
  type?: string
  category?: string
  message?: string
  level?: SeverityLevel
  data?: Record<string, unknown>
  timestamp?: number
}

export type BreadcrumbHint = Record<string, unknown>

export type Context = Record<string, unknown>

export type ExceptionValue = {
  type: string
  value: string
  stacktrace?: string
  mechanism?: { type: string; handled: boolean }
}

// Sentry's event shape, so beforeSend callbacks carry over. The one difference:
// stacktrace is the runtime's own stack text, which OpenTelemetry sends as-is.
export type Event = {
  event_id: string
  timestamp: number
  level: SeverityLevel
  message?: string
  exception?: { values: ExceptionValue[] }
  tags: Record<string, Primitive>
  extra: Record<string, unknown>
  contexts: Record<string, Context>
  user?: User
  breadcrumbs: Breadcrumb[]
  release?: string
  environment?: string
  request?: { url?: string }
}

export type EventHint = {
  originalException?: unknown
  syntheticException?: Error
  event_id?: string
  [key: string]: unknown
}

export type CaptureContext = {
  tags?: Record<string, Primitive>
  extra?: Record<string, unknown>
  contexts?: Record<string, Context>
  user?: User
  level?: SeverityLevel
}

export type BreadcrumbOptions = {
  console?: boolean
  dom?: boolean
  fetch?: boolean
  xhr?: boolean
  history?: boolean
}

export type SharedOptions = {
  dsn?: string
  release?: string
  environment?: string
  serviceName?: string
  enabled?: boolean
  sampleRate?: number
  maxBreadcrumbs?: number
  debug?: boolean
  initialScope?: CaptureContext
  beforeSend?: (
    event: Event,
    hint: EventHint
  ) => Event | null | PromiseLike<Event | null>
  beforeBreadcrumb?: (
    breadcrumb: Breadcrumb,
    hint?: BreadcrumbHint
  ) => Breadcrumb | null
  ignoreErrors?: (string | RegExp)[]
}
