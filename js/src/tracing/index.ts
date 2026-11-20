import { context, propagation, trace } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import {
  registerInstrumentations,
  type Instrumentation
} from '@opentelemetry/instrumentation'
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch'
import { XMLHttpRequestInstrumentation } from '@opentelemetry/instrumentation-xml-http-request'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  StackContextManager,
  TraceIdRatioBasedSampler,
  TracerProvider,
  type SpanProcessor
} from '@opentelemetry/sdk-trace'
import { initBrowserErrors, type BrowserOptions } from '../browser/client'
import { resolvePublicLogsUrl } from '../core/endpoints'
import { resourceAttributes } from '../core/resource'

export * from '../core/public'
export {
  breadcrumbsIntegration,
  browserDefaultIntegrations as getDefaultIntegrations,
  globalHandlersIntegration
} from '../browser/instrument'
export type { Integration } from '../core/integrations'

export type TracingOptions = BrowserOptions & {
  tracesSampleRate?: number
  tracePropagationTargets?: (string | RegExp)[]
  tracesEndpoint?: string
  tracesHeaders?: Record<string, string>
  instrumentations?: Instrumentation[]
  spanProcessors?: SpanProcessor[]
}

const DEFAULT_SERVICE = 'web'

let tracerProvider: TracerProvider | undefined

const exportProcessors = (options: TracingOptions) => {
  const processors = [...(options.spanProcessors ?? [])]
  if (options.tracesEndpoint) {
    const exporter = new OTLPTraceExporter({
      url: options.tracesEndpoint,
      headers: options.tracesHeaders
    })
    processors.push(new BatchSpanProcessor({ exporter }))
  }
  return processors
}

// Spans are always created, so outgoing requests carry traceparent and errors
// link to their trace; they are exported only to a tracesEndpoint you give,
// since a browser can't hold the secret key the Instatus collector needs.
export const init = (options: TracingOptions) => {
  const client = initBrowserErrors(options)
  if (tracerProvider || options.enabled === false) return client

  tracerProvider = new TracerProvider({
    resource: resourceFromAttributes(
      resourceAttributes(options, 'webjs', DEFAULT_SERVICE)
    ),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(options.tracesSampleRate ?? 1)
    }),
    spanProcessors: exportProcessors(options)
  })
  trace.setGlobalTracerProvider(tracerProvider)
  context.setGlobalContextManager(new StackContextManager().enable())
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())

  const propagateTraceHeaderCorsUrls = options.tracePropagationTargets ?? []
  const ignoreUrls = [
    options.tracesEndpoint,
    resolvePublicLogsUrl(options)
  ].filter((url): url is string => !!url)
  const provider = tracerProvider
  const unloadInstrumentations = registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new FetchInstrumentation({ propagateTraceHeaderCorsUrls, ignoreUrls }),
      new XMLHttpRequestInstrumentation({
        propagateTraceHeaderCorsUrls,
        ignoreUrls
      }),
      ...(options.instrumentations ?? [])
    ]
  })
  client?.addLifecycle({
    flush: async () => {
      await provider.forceFlush()
      return true
    },
    close: async () => {
      unloadInstrumentations()
      await provider.shutdown()
      trace.disable()
      tracerProvider = undefined
      return true
    }
  })
  return client
}

export const getTracerProvider = () => tracerProvider
