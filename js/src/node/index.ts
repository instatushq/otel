import {
  ROOT_CONTEXT,
  context,
  logs,
  metrics,
  propagation,
  trace,
  type Logger
} from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import {
  registerInstrumentations,
  type Instrumentation
} from '@opentelemetry/instrumentation'
import {
  detectResources,
  envDetector,
  hostDetector,
  processDetector,
  resourceFromAttributes,
  type Resource
} from '@opentelemetry/resources'
import {
  BatchLogRecordProcessor,
  LoggerProvider
} from '@opentelemetry/sdk-logs'
import {
  MeterProvider,
  PeriodicExportingMetricReader
} from '@opentelemetry/sdk-metrics'
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  TracerProvider,
  type SpanProcessor
} from '@opentelemetry/sdk-trace'
import {
  captureWithMechanism,
  getClient,
  getGlobalScope,
  setClient
} from '../core/api'
import { Client, type Sink, type TraceContext } from '../core/client'
import type { ErrorLogRecord } from '../core/attributes'
import {
  resolveIntegrations,
  setupIntegrations,
  type Integration,
  type IntegrationOptions
} from '../core/integrations'
import { createRateCap } from '../core/rate-cap'
import { resourceAttributes } from '../core/resource'
import { DEFAULT_MAX_BREADCRUMBS } from '../core/scope'
import type { SharedOptions } from '../core/types'
import { SDK_NAME, SDK_VERSION } from '../core/version'
import {
  resolveNodeExports,
  type NodeExportOptions,
  type SignalExport
} from './exports'

export * from '../core/public'
export { resolveNodeExports }
export type { Integration }

export type NodeOptions = SharedOptions &
  NodeExportOptions &
  IntegrationOptions & {
    tracesSampleRate?: number
    instrumentations?: Instrumentation[]
    spanProcessors?: SpanProcessor[]
    metricsExportIntervalMs?: number
    maxEventsPerMinute?: number
    shutdownTimeoutMs?: number
  }

const DEFAULT_MAX_EVENTS_PER_MINUTE = 300
const MINUTE_MS = 60_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2000
// The public error intake takes small batches; the collector takes the default.
const PUBLIC_BATCH_SIZE = 10

type Providers = {
  logger: LoggerProvider
  tracer: TracerProvider
  meter?: MeterProvider
  unloadInstrumentations?: () => void
}

let providers: Providers | undefined

const fallbackServiceName = () => process.env.npm_package_name || 'node'

const buildResource = (options: NodeOptions): Resource =>
  detectResources({
    detectors: [envDetector, hostDetector, processDetector]
  }).merge(
    resourceFromAttributes(
      resourceAttributes(
        {
          ...options,
          serviceName: options.serviceName ?? process.env.OTEL_SERVICE_NAME
        },
        'nodejs',
        fallbackServiceName()
      )
    )
  )

// React Native's global types, which @sentry/react-native brings into the
// same compile, type timers as numbers, so unref is looked up rather than typed.
const unref = (timer: unknown) => (timer as { unref?: () => void }).unref?.()

const withTimeout = async (work: Promise<unknown>, timeoutMs: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
    unref(timer)
  })
  try {
    return await Promise.race([work.then(() => true), timeout])
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

const recordContextOf = (traceContext: TraceContext | undefined) => {
  if (!traceContext) return ROOT_CONTEXT
  return trace.setSpanContext(ROOT_CONTEXT, {
    ...traceContext,
    isRemote: false
  })
}

const loggerSink = (logger: Logger, all: () => Providers | undefined): Sink => {
  const flushAll = (timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) => {
    const current = all()
    if (!current) return Promise.resolve(true)
    const work = Promise.all([
      current.logger.forceFlush(),
      current.tracer.forceFlush(),
      current.meter?.forceFlush()
    ])
    return withTimeout(work, timeoutMs)
  }
  return {
    emit: (record: ErrorLogRecord, traceContext?: TraceContext) => {
      logger.emit({
        timestamp: record.timestampMs,
        severityNumber: record.severityNumber,
        severityText: record.severityText,
        body: record.body,
        attributes: record.attributes,
        context: recordContextOf(traceContext)
      })
    },
    flush: flushAll,
    close: async (timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) => {
      const current = all()
      if (!current) return true
      providers = undefined
      current.unloadInstrumentations?.()
      const work = Promise.all([
        current.logger.shutdown(),
        current.tracer.shutdown(),
        current.meter?.shutdown()
      ])
      return withTimeout(work, timeoutMs)
    }
  }
}

const logProvider = (resource: Resource, target: SignalExport | undefined) => {
  if (!target) return new LoggerProvider({ resource })
  const { url, headers, isPublic } = target
  const processor = new BatchLogRecordProcessor({
    exporter: new OTLPLogExporter({ url, headers }),
    maxExportBatchSize: isPublic ? PUBLIC_BATCH_SIZE : undefined
  })
  return new LoggerProvider({ resource, processors: [processor] })
}

const traceProvider = (
  options: NodeOptions,
  resource: Resource,
  target: SignalExport | undefined
) => {
  const spanProcessors = [...(options.spanProcessors ?? [])]
  if (target)
    spanProcessors.push(
      new BatchSpanProcessor({ exporter: new OTLPTraceExporter(target) })
    )
  return new TracerProvider({
    resource,
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(options.tracesSampleRate ?? 1)
    }),
    spanProcessors
  })
}

const meterProvider = (
  options: NodeOptions,
  resource: Resource,
  target: SignalExport
) =>
  new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(target),
        exportIntervalMillis: options.metricsExportIntervalMs
      })
    ]
  })

const exitAfterFatal = async (error: unknown, timeoutMs: number) => {
  console.error(error)
  await getClient()?.flush(timeoutMs)
  process.exit(1)
}

// Node prints and exits on an uncaught exception only while nothing listens,
// so this does the same after flushing, unless the app has its own listener.
export const onUncaughtExceptionIntegration = ({
  exitTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS
} = {}): Integration => ({
  name: 'OnUncaughtException',
  setup: () => {
    const onUncaught = (error: unknown) => {
      captureWithMechanism(
        error,
        { type: 'onuncaughtexception', handled: false },
        { level: 'fatal' }
      )
      const others = process
        .listeners('uncaughtException')
        .filter((listener) => listener !== onUncaught)
      if (others.length === 0) void exitAfterFatal(error, exitTimeoutMs)
    }
    process.on('uncaughtException', onUncaught)
  }
})

export const onUnhandledRejectionIntegration = (): Integration => ({
  name: 'OnUnhandledRejection',
  setup: () => {
    process.on('unhandledRejection', (reason) => {
      captureWithMechanism(reason, {
        type: 'onunhandledrejection',
        handled: false
      })
      console.warn('[instatus] unhandled promise rejection:', reason)
    })
  }
})

export const getDefaultIntegrations = () => [
  onUncaughtExceptionIntegration(),
  onUnhandledRejectionIntegration()
]

export const init = (options: NodeOptions = {}) => {
  if (providers) return undefined
  const enabled = options.enabled !== false
  // Disabled, the providers still exist so startSpan and context work, but
  // nothing is exported and no instrumentation is registered.
  const exports = enabled ? resolveNodeExports(options, process.env) : {}
  if (enabled && !exports.logs) {
    console.warn(
      '[instatus] init needs an apiKey (or INSTATUS_API_KEY), a dsn or an OTLP endpoint'
    )
  }
  const resource = buildResource(options)
  const current: Providers = {
    logger: logProvider(resource, exports.logs),
    tracer: traceProvider(options, resource, exports.traces),
    meter: exports.metrics
      ? meterProvider(options, resource, exports.metrics)
      : undefined
  }
  providers = current

  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable()
  )
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  trace.setGlobalTracerProvider(current.tracer)
  logs.setGlobalLoggerProvider(current.logger)
  if (current.meter) metrics.setGlobalMeterProvider(current.meter)
  if (enabled && options.instrumentations?.length) {
    current.unloadInstrumentations = registerInstrumentations({
      tracerProvider: current.tracer,
      meterProvider: current.meter,
      loggerProvider: current.logger,
      instrumentations: options.instrumentations
    })
  }

  const shutdownTimeoutMs =
    options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  const client = new Client({
    ...options,
    sink: loggerSink(
      current.logger.getLogger(SDK_NAME, SDK_VERSION),
      () => providers
    ),
    // Errors shows breadcrumbs as steps in the browser, so server events
    // leave them out, as the backend does for Sentry's server SDKs.
    sendBreadcrumbs: false,
    rateCap: createRateCap(
      options.maxEventsPerMinute ?? DEFAULT_MAX_EVENTS_PER_MINUTE,
      MINUTE_MS
    )
  })
  setClient(client)
  const scope = getGlobalScope()
  scope.maxBreadcrumbs = options.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS
  if (options.initialScope) scope.update(options.initialScope)
  if (enabled) {
    setupIntegrations(resolveIntegrations(options, getDefaultIntegrations), {})
  }
  process.once('beforeExit', () => void client.flush(shutdownTimeoutMs))
  return client
}
