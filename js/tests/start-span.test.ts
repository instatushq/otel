import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SpanStatusCode,
  trace,
  type Span,
  type Tracer
} from '@opentelemetry/api'
import { startSpan } from '../src/core/api'

const fakeTracer = () => {
  const statuses: { code: number; message?: string }[] = []
  const span = {
    setStatus: (status: { code: number; message?: string }) => {
      statuses.push(status)
      return span
    },
    end: () => undefined
  } as unknown as Span
  const tracer = {
    startActiveSpan: (
      _name: string,
      _options: unknown,
      run: (span: Span) => unknown
    ) => run(span)
  } as unknown as Tracer
  vi.spyOn(trace, 'getTracer').mockReturnValue(tracer)
  return statuses
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('startSpan', () => {
  it('filters card numbers out of the failed span status', () => {
    const statuses = fakeTracer()
    expect(() =>
      startSpan({ name: 'charge' }, () => {
        throw new Error('card 4111 1111 1111 1111 declined')
      })
    ).toThrow()
    expect(statuses).toEqual([
      { code: SpanStatusCode.ERROR, message: 'card [Filtered] declined' }
    ])
  })

  it('filters a rejected promise the same way', async () => {
    const statuses = fakeTracer()
    await expect(
      startSpan({ name: 'charge' }, async () => {
        throw new Error('card 4111 1111 1111 1111 declined')
      })
    ).rejects.toThrow()
    expect(statuses[0]?.message).toBe('card [Filtered] declined')
  })
})
