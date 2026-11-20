import { DEFAULT_OTLP_ENDPOINT, resolvePublicLogsUrl } from '../core/endpoints'

export type Signal = 'logs' | 'traces' | 'metrics'

// url undefined leaves the OTLP exporter to read OTEL_EXPORTER_OTLP_* itself.
export type SignalExport = {
  url?: string
  headers: Record<string, string>
  isPublic?: boolean
}

export type NodeExports = Partial<Record<Signal, SignalExport>>

export type NodeExportOptions = {
  apiKey?: string
  siteId?: string
  endpoint?: string
  dsn?: string
  browserKey?: string
  logsEndpoint?: string
}

type Env = Record<string, string | undefined>

const SIGNALS: Signal[] = ['logs', 'traces', 'metrics']

const hasEnvEndpoint = (env: Env, signal: Signal) =>
  !!env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`] ||
  !!env.OTEL_EXPORTER_OTLP_ENDPOINT

const signalUrl = (endpoint: string, signal: Signal) =>
  `${endpoint.replace(/\/+$/, '')}/v1/${signal}`

const urlFor = (options: NodeExportOptions, env: Env, signal: Signal) => {
  if (options.endpoint) return signalUrl(options.endpoint, signal)
  if (hasEnvEndpoint(env, signal)) return undefined
  return signalUrl(DEFAULT_OTLP_ENDPOINT, signal)
}

const everySignal = (build: (signal: Signal) => SignalExport): NodeExports =>
  Object.fromEntries(SIGNALS.map((signal) => [signal, build(signal)]))

// An API key sends every signal to the collector. Without one, a DSN or
// browser key still reports errors, through the same intake as the browser.
export const resolveNodeExports = (
  options: NodeExportOptions,
  env: Env
): NodeExports => {
  const apiKey = options.apiKey ?? env.INSTATUS_API_KEY
  const siteId = options.siteId ?? env.INSTATUS_SITE_ID
  if (apiKey) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`
    }
    if (siteId) headers['X-Instatus-Site-Id'] = siteId
    return everySignal((signal) => ({
      url: urlFor(options, env, signal),
      headers
    }))
  }
  if (options.endpoint) {
    return everySignal((signal) => ({
      url: urlFor(options, env, signal),
      headers: {}
    }))
  }
  // Each signal with an OTEL_EXPORTER_OTLP_* endpoint exports there; logs
  // without one fall back to the DSN's error intake.
  const exports: NodeExports = {}
  for (const signal of SIGNALS) {
    if (hasEnvEndpoint(env, signal)) exports[signal] = { headers: {} }
  }
  const logsUrl = resolvePublicLogsUrl(options)
  if (!exports.logs && logsUrl) {
    exports.logs = { url: logsUrl, headers: {}, isPublic: true }
  }
  return exports
}
