import type { Attributes } from './attributes'
import { SDK_NAME, SDK_VERSION } from './version'

export type ResourceOptions = {
  serviceName?: string
  release?: string
  environment?: string
}

// Sentry's release and environment are OpenTelemetry resource attributes.
export const resourceAttributes = (
  options: ResourceOptions,
  language: string,
  fallbackServiceName: string
): Attributes => {
  const attributes: Attributes = {
    'service.name': options.serviceName || fallbackServiceName,
    'telemetry.sdk.name': SDK_NAME,
    'telemetry.sdk.version': SDK_VERSION,
    'telemetry.sdk.language': language
  }
  if (options.release) attributes['service.version'] = options.release
  if (options.environment) {
    attributes['deployment.environment.name'] = options.environment
  }
  return attributes
}
