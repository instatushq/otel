export const BROWSER_KEY_PREFIX = 'ib_'

const SENTRY_KEY_PATTERN = /^[0-9a-f]{36}$/
const BROWSER_KEY_PATTERN = /^ib_[A-Za-z0-9_-]{24}$/
const BASE64URL =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export type Dsn = {
  origin: string
  publicKey: string
  browserKey: string
  projectId: string
}

export const isBrowserKey = (value: string) => BROWSER_KEY_PATTERN.test(value)

const hexToBytes = (hex: string) => {
  const bytes: number[] = []
  for (let index = 0; index < hex.length; index += 2) {
    bytes.push(parseInt(hex.slice(index, index + 2), 16))
  }
  return bytes
}

// 18 bytes is a multiple of 3, so the encoding never needs padding.
const toBase64Url = (bytes: number[]) => {
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const chunk =
      (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2]
    output +=
      BASE64URL[(chunk >> 18) & 63] +
      BASE64URL[(chunk >> 12) & 63] +
      BASE64URL[(chunk >> 6) & 63] +
      BASE64URL[chunk & 63]
  }
  return output
}

// Mirrors the backend's sentry-key helper: Sentry SDKs only accept word
// characters in a DSN key, so Instatus writes the browser key's bytes as hex.
export const browserKeyFromSentryKey = (sentryKey: string) => {
  const hex = sentryKey.toLowerCase()
  if (!SENTRY_KEY_PATTERN.test(hex)) return null
  return `${BROWSER_KEY_PREFIX}${toBase64Url(hexToBytes(hex))}`
}

export const parseDsn = (dsn: string): Dsn | null => {
  let url: URL
  try {
    url = new URL(dsn)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const publicKey = decodeURIComponent(url.username)
  const browserKey = browserKeyFromSentryKey(publicKey)
  const projectId = url.pathname.split('/').filter(Boolean).pop()
  if (!browserKey || !projectId) return null
  return {
    origin: `${url.protocol}//${url.host}`,
    publicKey: publicKey.toLowerCase(),
    browserKey,
    projectId
  }
}

export const browserLogsUrl = (origin: string, browserKey: string) =>
  `${origin.replace(/\/+$/, '')}/v1/browser/${browserKey}/v1/logs`
