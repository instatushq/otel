import { initBrowserErrors, type BrowserOptions } from './client'

export * from '../core/public'
export type { BrowserOptions }
export {
  breadcrumbsIntegration,
  browserDefaultIntegrations as getDefaultIntegrations,
  globalHandlersIntegration
} from './instrument'
export type { Integration } from '../core/integrations'

export const init = (options: BrowserOptions) => initBrowserErrors(options)
