import { addBreadcrumb, captureWithMechanism } from '../core/api'
import type { Integration } from '../core/integrations'
import type { BreadcrumbOptions, SeverityLevel } from '../core/types'
import {
  bareUrl,
  clickLabel,
  consoleMessage,
  errorFromEvent,
  errorFromRejection,
  isOpaqueScriptError,
  pathOf
} from './breadcrumb-format'

const recordRequest = (
  category: 'fetch' | 'xhr',
  method: string | undefined,
  url: string | null,
  status: number,
  startedAt: number
) => {
  if (!url) return
  addBreadcrumb({
    type: 'http',
    category,
    timestamp: startedAt / 1000,
    data: {
      method: (method || 'GET').toUpperCase(),
      url,
      status_code: status,
      duration_ms: Date.now() - startedAt
    }
  })
}

const instrumentClicks = () => {
  document.addEventListener(
    'click',
    (event) => {
      const text = clickLabel(event.target)
      if (text) addBreadcrumb({ category: 'ui.click', message: text })
    },
    true
  )
}

const instrumentHistory = () => {
  let lastPath = pathOf(location.href)
  const navigated = () => {
    const path = pathOf(location.href)
    if (path === lastPath) return
    addBreadcrumb({
      category: 'navigation',
      data: { from: lastPath, to: path }
    })
    lastPath = path
  }
  for (const name of ['pushState', 'replaceState'] as const) {
    const original = history[name]
    history[name] = function (
      this: History,
      ...args: Parameters<History['pushState']>
    ) {
      const result = original.apply(this, args)
      navigated()
      return result
    }
  }
  addEventListener('popstate', navigated)
}

type FetchInput = RequestInfo | URL
type Fetch = (input: FetchInput, init?: RequestInit) => Promise<Response>

const requestUrlOf = (input: FetchInput) => {
  if (typeof input === 'string' || input instanceof URL) return input
  return input.url
}

const requestMethodOf = (input: FetchInput, init?: RequestInit) => {
  if (init?.method) return init.method
  if (typeof input === 'object' && 'method' in input) return input.method
  return undefined
}

const instrumentFetch = (ignorePrefix: string) => {
  const original: Fetch | undefined = window.fetch
  if (!original) return
  const instrumented: Fetch = function (this: unknown, input, init) {
    const startedAt = Date.now()
    const method = requestMethodOf(input, init)
    const url = bareUrl(requestUrlOf(input), location.href, ignorePrefix)
    return original.call(this, input, init).then(
      (response) => {
        recordRequest('fetch', method, url, response.status, startedAt)
        return response
      },
      (error: unknown) => {
        recordRequest('fetch', method, url, 0, startedAt)
        throw error
      }
    )
  }
  window.fetch = instrumented as typeof window.fetch
}

type TrackedRequest = XMLHttpRequest & {
  __instatus?: { method: string; url: string | null }
}

const instrumentXhr = (ignorePrefix: string) => {
  const prototype = window.XMLHttpRequest?.prototype
  if (!prototype) return
  const open = prototype.open
  const send = prototype.send
  prototype.open = function (this: TrackedRequest, ...args: unknown[]) {
    const [method, url] = args as [string, string | URL]
    this.__instatus = { method, url: bareUrl(url, location.href, ignorePrefix) }
    return (open as (...openArgs: unknown[]) => void).apply(this, args)
  } as typeof open
  prototype.send = function (
    this: TrackedRequest,
    body?: Document | XMLHttpRequestBodyInit | null
  ) {
    const details = this.__instatus
    if (details) {
      const startedAt = Date.now()
      this.addEventListener(
        'loadend',
        () =>
          recordRequest(
            'xhr',
            details.method,
            details.url,
            this.status,
            startedAt
          ),
        { once: true }
      )
    }
    return send.call(this, body)
  }
}

const CONSOLE_LEVELS: Record<'error' | 'warn', SeverityLevel> = {
  error: 'error',
  warn: 'warning'
}

const instrumentConsole = () => {
  for (const name of ['error', 'warn'] as const) {
    const original = console[name]
    console[name] = function (...args: unknown[]) {
      addBreadcrumb({
        category: 'console',
        level: CONSOLE_LEVELS[name],
        message: consoleMessage(args)
      })
      return original.apply(this, args)
    }
  }
}

const instrumentGlobalHandlers = () => {
  addEventListener('error', (event) => {
    const error = errorFromEvent(event)
    const stack = (error as Error).stack
    if (isOpaqueScriptError(String((error as Error).message), stack)) return
    captureWithMechanism(error, { type: 'onerror', handled: false })
  })
  addEventListener('unhandledrejection', (event) => {
    captureWithMechanism(errorFromRejection(event.reason), {
      type: 'onunhandledrejection',
      handled: false
    })
  })
}

// Patches stay in place after close, as in Sentry, and a second init doesn't
// patch again.
const onceOn = (key: string, install: () => void) => {
  if (typeof window === 'undefined') return
  const marker = Symbol.for(`instatus.otel.${key}`)
  const target = window as unknown as Record<symbol, boolean>
  if (target[marker]) return
  target[marker] = true
  install()
}

export const globalHandlersIntegration = (): Integration => ({
  name: 'GlobalHandlers',
  setup: () => onceOn('global-handlers', instrumentGlobalHandlers)
})

export const breadcrumbsIntegration = (
  options: BreadcrumbOptions = {}
): Integration => ({
  name: 'Breadcrumbs',
  setup: ({ ingestUrl = '' }) => {
    if (options.dom !== false) onceOn('dom', instrumentClicks)
    if (options.history !== false) onceOn('history', instrumentHistory)
    if (options.fetch !== false)
      onceOn('fetch', () => instrumentFetch(ingestUrl))
    if (options.xhr !== false) onceOn('xhr', () => instrumentXhr(ingestUrl))
    if (options.console !== false) onceOn('console', instrumentConsole)
  }
})

export const browserDefaultIntegrations = () => [
  globalHandlersIntegration(),
  breadcrumbsIntegration()
]
