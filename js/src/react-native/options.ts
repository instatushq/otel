import type { ReactNativeOptions as SentryOptions } from '@sentry/react-native'
import { parseDsn } from '../core/dsn'
import { scrubBreadcrumb, scrubSentryEvent } from './scrub-event'

type UnsupportedOption =
  | 'replaysSessionSampleRate'
  | 'replaysOnErrorSampleRate'
  | 'profilesSampleRate'
  | 'profileSessionSampleRate'
  | 'profileLifecycle'

const UNSUPPORTED_OPTIONS = new Set<string>([
  'replaysSessionSampleRate',
  'replaysOnErrorSampleRate',
  'profilesSampleRate',
  'profileSessionSampleRate',
  'profileLifecycle'
] satisfies UnsupportedOption[])

// The intake keeps errors only, so these would record on the device and then
// be dropped. Removing them by name also catches ones turned on through
// `_experiments` or added by hand.
const UNSUPPORTED_INTEGRATIONS = new Set([
  'MobileReplay',
  'MobileReplayNetworkBodies',
  'MobileReplayNetworkDetails',
  'Replay',
  'HermesProfiling',
  'ProfilingIntegration',
  'MobileFeedback',
  'AutoInjectMobileFeedback',
  'AutoInjectMobileFeedbackButton',
  'AutoInjectMobileScreenshotButton',
  'ShakeToReport'
])

// The intake accepts and drops sessions, screenshots and view hierarchies.
const INSTATUS_DEFAULTS = {
  enableAutoSessionTracking: false,
  attachScreenshot: false,
  attachViewHierarchy: false
} satisfies Partial<SentryOptions>

export type ReactNativeOptions = Omit<SentryOptions, UnsupportedOption> & {
  dsn: string
  serviceName?: string
}

type Integration = { name: string }
type IntegrationsOption = SentryOptions['integrations']
type IntegrationList = Extract<IntegrationsOption, unknown[]>

export const isSupportedIntegration = (integration: Integration) =>
  !UNSUPPORTED_INTEGRATIONS.has(integration.name)

// Sentry merges an array into the defaults and hands a function the defaults;
// both end in the same list, so filtering it keeps Sentry's rules.
export const supportedIntegrations =
  (integrations: IntegrationsOption) => (defaults: IntegrationList) => {
    const chosen =
      typeof integrations === 'function'
        ? integrations(defaults)
        : [...defaults, ...(integrations ?? [])]
    return chosen.filter(isSupportedIntegration)
  }

type BeforeSend = NonNullable<SentryOptions['beforeSend']>
type BeforeBreadcrumb = NonNullable<SentryOptions['beforeBreadcrumb']>
type SentEvent = Parameters<BeforeSend>[0]

const isThenable = <T>(value: unknown): value is PromiseLike<T> =>
  typeof (value as PromiseLike<T> | null)?.then === 'function'

const scrubOrDrop = (event: SentEvent | null) =>
  event && scrubSentryEvent(event)

// Filters run after the app's own hook, as on the browser and Node entries.
export const scrubbedBeforeSend =
  (beforeSend?: BeforeSend): BeforeSend =>
  (event, hint) => {
    const result = beforeSend ? beforeSend(event, hint) : event
    if (isThenable<SentEvent | null>(result)) return result.then(scrubOrDrop)
    return scrubOrDrop(result)
  }

export const scrubbedBeforeBreadcrumb =
  (beforeBreadcrumb?: BeforeBreadcrumb): BeforeBreadcrumb =>
  (breadcrumb, hint) => {
    const result = beforeBreadcrumb
      ? beforeBreadcrumb(breadcrumb, hint)
      : breadcrumb
    return result && scrubBreadcrumb(result)
  }

export const toSentryOptions = ({
  serviceName: _serviceName,
  ...options
}: ReactNativeOptions): SentryOptions | null => {
  if (!parseDsn(options.dsn)) return null
  const supported = Object.fromEntries(
    Object.entries(options).filter(([key]) => !UNSUPPORTED_OPTIONS.has(key))
  )
  return {
    ...INSTATUS_DEFAULTS,
    ...supported,
    integrations: supportedIntegrations(options.integrations),
    beforeSend: scrubbedBeforeSend(options.beforeSend),
    beforeBreadcrumb: scrubbedBeforeBreadcrumb(options.beforeBreadcrumb)
  }
}
