import { Component, type ErrorInfo, type ReactNode } from 'react'
import { captureWithMechanism, withScope } from '../core/api'
import type { Scope } from '../core/scope'

export type FallbackRender = (props: {
  error: unknown
  componentStack: string
  eventId: string
  resetError: () => void
}) => ReactNode

export type ErrorBoundaryProps = {
  children?: ReactNode
  fallback?: ReactNode | FallbackRender
  onError?: (error: unknown, componentStack: string, eventId: string) => void
  onReset?: (error: unknown, componentStack: string, eventId: string) => void
  beforeCapture?: (scope: Scope, error: unknown, componentStack: string) => void
}

type ErrorBoundaryState =
  | { error: null }
  | { error: unknown; componentStack: string; eventId: string }

// Sentry's ErrorBoundary props, reporting through Instatus with the React
// component stack as the react.component_stack attribute.
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const componentStack = info.componentStack ?? ''
    const eventId = withScope((scope) => {
      scope.setContext('react', { component_stack: componentStack })
      this.props.beforeCapture?.(scope, error, componentStack)
      return captureWithMechanism(error, {
        type: 'react.errorboundary',
        handled: true
      })
    })
    this.props.onError?.(error, componentStack, eventId)
    this.setState({ error, componentStack, eventId })
  }

  resetError = () => {
    const { state } = this
    if (state.error !== null && 'eventId' in state) {
      this.props.onReset?.(state.error, state.componentStack, state.eventId)
    }
    this.setState({ error: null })
  }

  render() {
    const { state } = this
    if (state.error === null || !('eventId' in state))
      return this.props.children
    const { fallback } = this.props
    if (typeof fallback !== 'function') return fallback ?? null
    return fallback({
      error: state.error,
      componentStack: state.componentStack,
      eventId: state.eventId,
      resetError: this.resetError
    })
  }
}

export const withErrorBoundary = <P extends object>(
  Wrapped: (props: P) => ReactNode,
  boundaryProps: ErrorBoundaryProps = {}
) => {
  const WithErrorBoundary = (props: P) => (
    <ErrorBoundary {...boundaryProps}>
      <Wrapped {...props} />
    </ErrorBoundary>
  )
  WithErrorBoundary.displayName = `withErrorBoundary(${Wrapped.name || 'Component'})`
  return WithErrorBoundary
}
