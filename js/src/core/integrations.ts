export type IntegrationContext = { ingestUrl?: string }

export type Integration = {
  name: string
  setup: (context: IntegrationContext) => void
}

export type IntegrationsOption =
  | Integration[]
  | ((defaults: Integration[]) => Integration[])

export type IntegrationOptions = {
  integrations?: IntegrationsOption
  defaultIntegrations?: Integration[] | false
}

// Sentry's rules: user integrations replace defaults of the same name, and a
// function gets the defaults to filter or extend.
export const resolveIntegrations = (
  { integrations, defaultIntegrations }: IntegrationOptions,
  platformDefaults: () => Integration[]
) => {
  const defaults =
    defaultIntegrations === false
      ? []
      : (defaultIntegrations ?? platformDefaults())
  if (typeof integrations === 'function') return integrations(defaults)
  const custom = integrations ?? []
  const customNames = new Set(custom.map((integration) => integration.name))
  return [
    ...defaults.filter((integration) => !customNames.has(integration.name)),
    ...custom
  ]
}

export const setupIntegrations = (
  integrations: Integration[],
  context: IntegrationContext
) => {
  for (const integration of integrations) integration.setup(context)
}
