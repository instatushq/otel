import type { Breadcrumb } from './types'

// The attribute and JSON shape Instatus Errors reads, see the backend's
// browser-errors/helpers/breadcrumbs.ts.
export const BREADCRUMBS_ATTRIBUTE = 'instatus.breadcrumbs'

export type InstatusBreadcrumb =
  | { at: number; kind: 'click'; text: string }
  | { at: number; kind: 'nav'; from: string; to: string }
  | {
      at: number
      kind: 'request'
      method: string
      url: string
      status: number
      ms?: number
    }
  | { at: number; kind: 'console'; text: string }

const HTTP_CATEGORIES = new Set(['fetch', 'xhr', 'http'])
const LOUD_LEVELS = new Set(['warning', 'error', 'fatal'])
const MAX_CLICK_TEXT = 40
const MAX_PATH = 300
const MAX_METHOD = 10
const MAX_CONSOLE_TEXT = 200

const asString = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : ''

const asNumber = (value: unknown) => {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number)
    ? number
    : undefined
}

const toRequest = (
  data: Record<string, unknown>,
  at: number
): InstatusBreadcrumb | null => {
  const url = asString(data.url)
  if (!url) return null
  const ms = asNumber(data.duration_ms)
  const status = asNumber(data.status_code) ?? 0
  return {
    at,
    kind: 'request',
    method: (asString(data.method) || 'GET').toUpperCase().slice(0, MAX_METHOD),
    url: url.slice(0, MAX_PATH),
    status: Math.min(999, Math.max(0, Math.round(status))),
    ...(ms === undefined ? {} : { ms: Math.max(0, Math.round(ms)) })
  }
}

const consoleText = (breadcrumb: Breadcrumb) => {
  const message = asString(breadcrumb.message)
  const category = breadcrumb.category
  if (!category || category === 'console') return message
  return `${category}: ${message}`
}

export const toInstatusBreadcrumb = (
  breadcrumb: Breadcrumb
): InstatusBreadcrumb | null => {
  const seconds = breadcrumb.timestamp
  if (seconds === undefined || !Number.isFinite(seconds)) return null
  const at = Math.round(seconds * 1000)
  const category = breadcrumb.category ?? ''
  const data = breadcrumb.data ?? {}

  if (category === 'ui.click') {
    const text = asString(breadcrumb.message).slice(0, MAX_CLICK_TEXT)
    return text ? { at, kind: 'click', text } : null
  }
  if (category === 'navigation') {
    return {
      at,
      kind: 'nav',
      from: asString(data.from).slice(0, MAX_PATH),
      to: asString(data.to).slice(0, MAX_PATH)
    }
  }
  if (breadcrumb.type === 'http' || HTTP_CATEGORIES.has(category)) {
    return toRequest(data, at)
  }
  // Errors shows these as console errors, so quieter ones are left out, as
  // the backend does for Sentry SDK breadcrumbs.
  if (!LOUD_LEVELS.has(breadcrumb.level ?? '')) return null
  const text = consoleText(breadcrumb).slice(0, MAX_CONSOLE_TEXT)
  return text ? { at, kind: 'console', text } : null
}

export const toInstatusBreadcrumbs = (breadcrumbs: Breadcrumb[]) =>
  breadcrumbs
    .map(toInstatusBreadcrumb)
    .filter(
      (breadcrumb): breadcrumb is InstatusBreadcrumb => breadcrumb !== null
    )

export const serializeBreadcrumbs = (breadcrumbs: Breadcrumb[]) => {
  const mapped = toInstatusBreadcrumbs(breadcrumbs)
  return mapped.length > 0 ? JSON.stringify(mapped) : undefined
}
