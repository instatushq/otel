import { browserLogsUrl, isBrowserKey, parseDsn } from './dsn'

export const DEFAULT_INGEST_ORIGIN = 'https://api.instatus.com'
export const DEFAULT_OTLP_ENDPOINT = 'https://otel.instatus.com'

export type PublicKeyOptions = {
  dsn?: string
  browserKey?: string
  logsEndpoint?: string
}

// A browser key is public, so it only reaches the backend's error intake,
// which checks its page's allowed origins and rate limits it.
export const resolvePublicLogsUrl = ({
  dsn,
  browserKey,
  logsEndpoint
}: PublicKeyOptions) => {
  if (logsEndpoint) return logsEndpoint
  if (dsn) {
    const parsed = parseDsn(dsn)
    return parsed ? browserLogsUrl(parsed.origin, parsed.browserKey) : null
  }
  if (browserKey && isBrowserKey(browserKey)) {
    return browserLogsUrl(DEFAULT_INGEST_ORIGIN, browserKey)
  }
  return null
}
