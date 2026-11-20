const CLICKABLE =
  'a,button,summary,label,[role=button],[role=link],[role=menuitem],[role=tab],input[type=button],input[type=submit]'
const MAX_CLICK_TEXT = 40
const MAX_PATH = 300
const MAX_CONSOLE_TEXT = 200

type ClickTarget = {
  closest?: (selector: string) => ClickTarget | null
  getAttribute?: (name: string) => string | null
  title?: string
  tagName?: string
  value?: string
  innerText?: string
  id?: string
}

// Only buttons and links are named, and never by what was typed into a field.
export const clickLabel = (element: unknown): string | null => {
  const target = (element as ClickTarget | null)?.closest?.(CLICKABLE)
  if (!target) return null
  let name = target.getAttribute?.('aria-label') || target.title
  if (!name && target.tagName === 'INPUT') name = target.value
  if (!name)
    name = target.innerText || target.id || target.tagName?.toLowerCase()
  if (!name) return null
  return String(name).replace(/\s+/g, ' ').trim().slice(0, MAX_CLICK_TEXT)
}

// Query strings carry tokens and personal data, so a request keeps its path.
export const bareUrl = (
  value: unknown,
  pageUrl: string,
  ignorePrefix?: string
) => {
  try {
    const url = new URL(String(value), pageUrl)
    if (ignorePrefix && url.href.startsWith(ignorePrefix)) return null
    const page = new URL(pageUrl)
    const origin = url.origin === page.origin ? '' : url.origin
    return `${origin}${url.pathname}`.slice(0, MAX_PATH)
  } catch {
    return null
  }
}

export const pathOf = (pageUrl: string) => {
  try {
    return new URL(pageUrl).pathname.slice(0, MAX_PATH)
  } catch {
    return ''
  }
}

const describe = (value: unknown) => {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export const consoleMessage = (args: unknown[]) =>
  args.map(describe).join(' ').slice(0, MAX_CONSOLE_TEXT)

const SCRIPT_ERROR = 'Script error.'

// Cross-origin scripts without CORS report only "Script error." and nothing
// to act on, which Sentry drops by default too.
export const isOpaqueScriptError = (message: string, stack?: string) =>
  message === SCRIPT_ERROR && !stack

export type ErrorEventLike = {
  error?: unknown
  message?: string
  filename?: string
  lineno?: number
  colno?: number
}

export const errorFromEvent = (event: ErrorEventLike): unknown => {
  if (event.error) return event.error
  const message = event.message || 'Unknown error'
  const error = {
    name: 'Error',
    message,
    stack: undefined as string | undefined
  }
  if (event.filename) {
    error.stack = `Error: ${message}\n    at ${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}`
  }
  return error
}

export const errorFromRejection = (reason: unknown): unknown => {
  const isErrorLike =
    typeof reason === 'object' && reason !== null && 'message' in reason
  if (isErrorLike) return reason
  return {
    name: 'UnhandledRejection',
    message: `Non-Error promise rejection captured with value: ${describe(reason)}`
  }
}
