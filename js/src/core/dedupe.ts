import type { Event } from './types'

const MARKER = '__instatus_captured__'

// Same as Sentry's Dedupe integration: an event identical to the one just
// sent is a re-throw or a handler and boundary both reporting one error.
const signatureOf = (event: Event) => {
  const exception = event.exception?.values[0]
  if (exception) {
    return `${exception.type}|${exception.value}|${exception.stacktrace ?? ''}`
  }
  return `message|${event.message ?? ''}`
}

export const createDedupe = () => {
  let previous: string | undefined
  return (event: Event) => {
    const signature = signatureOf(event)
    const duplicate = signature === previous
    previous = signature
    return duplicate
  }
}

export const wasCaptured = (error: unknown) =>
  typeof error === 'object' && error !== null && MARKER in error

export const markCaptured = (error: unknown) => {
  if (typeof error !== 'object' || error === null) return
  try {
    Object.defineProperty(error, MARKER, { value: true, enumerable: false })
  } catch {
    return
  }
}
