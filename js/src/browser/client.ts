import { setClient, getGlobalScope } from '../core/api'
import { Client } from '../core/client'
import { resolvePublicLogsUrl } from '../core/endpoints'
import { createRateCap } from '../core/rate-cap'
import { resourceAttributes } from '../core/resource'
import { DEFAULT_MAX_BREADCRUMBS } from '../core/scope'
import type { Event, SharedOptions } from '../core/types'
import {
  resolveIntegrations,
  setupIntegrations,
  type IntegrationOptions
} from '../core/integrations'
import { browserDefaultIntegrations } from './instrument'
import { createBrowserTransport } from './transport'

export type BrowserOptions = SharedOptions &
  IntegrationOptions & {
    browserKey?: string
    logsEndpoint?: string
    headers?: Record<string, string>
    maxEventsPerPage?: number
  }

const DEFAULT_SERVICE = 'web'
const DEFAULT_MAX_EVENTS_PER_PAGE = 50

const withPageUrl = (event: Event): Event => {
  if (event.request?.url || typeof location === 'undefined') return event
  return { ...event, request: { ...event.request, url: location.href } }
}

export const initBrowserErrors = (options: BrowserOptions) => {
  const url = resolvePublicLogsUrl(options)
  if (!url) {
    console.warn('[instatus] init needs a dsn, a browserKey or a logsEndpoint')
    return undefined
  }
  const client = new Client({
    ...options,
    sink: createBrowserTransport({
      url,
      headers: options.headers,
      resource: resourceAttributes(options, 'webjs', DEFAULT_SERVICE)
    }),
    rateCap: createRateCap(
      options.maxEventsPerPage ?? DEFAULT_MAX_EVENTS_PER_PAGE,
      Number.POSITIVE_INFINITY
    ),
    enrich: withPageUrl
  })
  setClient(client)
  const scope = getGlobalScope()
  scope.maxBreadcrumbs = options.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS
  if (options.initialScope) scope.update(options.initialScope)
  if (options.enabled !== false) {
    setupIntegrations(
      resolveIntegrations(options, browserDefaultIntegrations),
      {
        ingestUrl: url
      }
    )
  }
  return client
}
