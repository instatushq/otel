import * as Sentry from '@sentry/react-native'
import { toSentryOptions, type ReactNativeOptions } from './options'

export type { ReactNativeOptions }
export { parseDsn } from '../core/dsn'

// Sentry's React Native SDK does the work on the device, so native crashes
// from sentry-cocoa and sentry-android reach the same DSN as JS errors.
export const init = (
  options: ReactNativeOptions
): ReturnType<typeof Sentry.getClient> => {
  const sentryOptions = toSentryOptions(options)
  if (!sentryOptions) {
    console.warn('[instatus] init needs an Instatus dsn')
    return undefined
  }
  Sentry.init(sentryOptions)
  if (options.serviceName) {
    Sentry.getGlobalScope().setTag('service', options.serviceName)
  }
  return Sentry.getClient()
}

export const isInitialized = () => Sentry.getClient() !== undefined

export {
  addBreadcrumb,
  captureEvent,
  captureException,
  captureMessage,
  close,
  ErrorBoundary,
  flush,
  getActiveSpan,
  getClient,
  getCurrentScope,
  getGlobalScope,
  getIsolationScope,
  lastEventId,
  nativeCrash,
  Scope,
  setContext,
  setExtra,
  setExtras,
  setTag,
  setTags,
  setUser,
  startInactiveSpan,
  startSpan,
  startSpanManual,
  TouchEventBoundary,
  withErrorBoundary,
  withScope,
  wrap
} from '@sentry/react-native'
export type {
  Breadcrumb,
  Event,
  SeverityLevel,
  User
} from '@sentry/react-native'
