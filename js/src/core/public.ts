export {
  addBreadcrumb,
  captureEvent,
  captureException,
  captureMessage,
  close,
  flush,
  getActiveSpan,
  getClient,
  getCurrentScope,
  getGlobalScope,
  getIsolationScope,
  isInitialized,
  lastEventId,
  setContext,
  setExtra,
  setExtras,
  setTag,
  setTags,
  setUser,
  startInactiveSpan,
  startSpan,
  startSpanManual,
  withIsolationScope,
  withScope,
  type StartSpanOptions
} from './api'
export { Scope } from './scope'
export { parseDsn, browserKeyFromSentryKey } from './dsn'
export { SDK_NAME, SDK_VERSION } from './version'
export type {
  Breadcrumb,
  BreadcrumbHint,
  BreadcrumbOptions,
  CaptureContext,
  Context,
  Event,
  EventHint,
  ExceptionValue,
  Primitive,
  SeverityLevel,
  User
} from './types'
