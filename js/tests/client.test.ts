import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addBreadcrumb,
  captureException,
  captureMessage,
  lastEventId,
  setClient,
  setTag,
  setUser,
  withScope,
  getClient,
  getGlobalScope
} from '../src/core/api'
import type { ErrorLogRecord } from '../src/core/attributes'
import { trace, type Span } from '@opentelemetry/api'
import { Client, type Sink } from '../src/core/client'
import { createRateCap } from '../src/core/rate-cap'
import type { ClientOptions } from '../src/core/client'

const recordingSink = () => {
  const records: ErrorLogRecord[] = []
  const sink: Sink = {
    emit: (record) => records.push(record),
    flush: async () => true,
    close: async () => true
  }
  return { records, sink }
}

const install = (options: Partial<ClientOptions> = {}) => {
  const { records, sink } = recordingSink()
  setClient(
    new Client({
      sink,
      rateCap: createRateCap(100, Number.POSITIVE_INFINITY),
      ...options
    })
  )
  return records
}

afterEach(() => {
  setClient(undefined)
  getGlobalScope().clear()
})

describe('capture pipeline', () => {
  it('sends a captured exception with the scope, release and environment', () => {
    const records = install({ release: 'web@1.2.3', environment: 'staging' })
    setUser({ id: 'u_1' })
    setTag('feature', 'checkout')
    addBreadcrumb({ category: 'ui.click', message: 'Pay' })
    const eventId = captureException(new Error('boom'))
    expect(records).toHaveLength(1)
    expect(records[0].attributes).toMatchObject({
      'exception.message': 'boom',
      'enduser.id': 'u_1',
      feature: 'checkout',
      'log.record.uid': eventId
    })
    expect(
      JSON.parse(String(records[0].attributes['instatus.breadcrumbs']))
    ).toMatchObject([{ kind: 'click', text: 'Pay' }])
    expect(lastEventId()).toBe(eventId)
  })

  it('leaves breadcrumbs out when the platform asks', () => {
    const records = install({ sendBreadcrumbs: false })
    addBreadcrumb({ category: 'ui.click', message: 'Pay' })
    captureException(new Error('server side'))
    expect(records[0].attributes['instatus.breadcrumbs']).toBeUndefined()
  })

  it('lets beforeSend change or drop an event', () => {
    const records = install({
      beforeSend: (event) => {
        if (event.message === 'drop me') return null
        return { ...event, tags: { ...event.tags, edited: true } }
      }
    })
    captureMessage('drop me', 'error')
    captureMessage('keep me', 'error')
    expect(records).toHaveLength(1)
    expect(records[0].attributes.edited).toBe(true)
  })

  it('waits for an async beforeSend', async () => {
    const records = install({ beforeSend: async (event) => event })
    captureException(new Error('later'))
    expect(records).toHaveLength(0)
    await vi.waitFor(() => expect(records).toHaveLength(1))
  })

  it('survives a beforeSend that throws', () => {
    const records = install({
      beforeSend: () => {
        throw new Error('bad hook')
      }
    })
    expect(() => captureException(new Error('x'))).not.toThrow()
    expect(records).toHaveLength(0)
  })

  it('samples with sampleRate', () => {
    const records = install({ sampleRate: 0.5 })
    const random = vi.spyOn(Math, 'random')
    random.mockReturnValueOnce(0.7)
    captureException(new Error('sampled out'))
    random.mockReturnValueOnce(0.2)
    captureException(new Error('kept'))
    expect(
      records.map((record) => record.attributes['exception.message'])
    ).toEqual(['kept'])
  })

  it('ignores errors matching ignoreErrors', () => {
    const records = install({
      ignoreErrors: ['ResizeObserver loop', /^AbortError:/]
    })
    captureException(new Error('ResizeObserver loop limit exceeded'))
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    captureException(abort)
    captureException(new Error('real'))
    expect(records).toHaveLength(1)
  })

  it('reports the same error object once', () => {
    const records = install()
    const error = new Error('once')
    captureException(error)
    captureException(new Error('between'))
    captureException(error)
    expect(records).toHaveLength(2)
  })

  it('drops repeats and stops at the rate cap', () => {
    const records = install({
      rateCap: createRateCap(2, Number.POSITIVE_INFINITY)
    })
    captureMessage('same', 'error')
    captureMessage('same', 'error')
    captureMessage('second', 'error')
    captureMessage('third', 'error')
    expect(records.map((record) => record.body)).toEqual(['same', 'second'])
  })

  it('sends nothing when disabled or not initialised', () => {
    expect(() => captureException(new Error('no client'))).not.toThrow()
    const records = install({ enabled: false })
    captureException(new Error('disabled'))
    expect(records).toHaveLength(0)
  })
})

describe('flush and close', () => {
  it('wait for an async beforeSend before flushing the sink', async () => {
    const order: string[] = []
    const sink: Sink = {
      emit: () => order.push('emit'),
      flush: async () => {
        order.push('flush')
        return true
      },
      close: async () => true
    }
    setClient(
      new Client({
        sink,
        rateCap: createRateCap(10, Number.POSITIVE_INFINITY),
        beforeSend: (event) =>
          new Promise((resolve) => setTimeout(() => resolve(event), 20))
      })
    )
    captureException(new Error('late'))
    const client = getClient()!
    expect(await client.flush(1000)).toBe(true)
    expect(order).toEqual(['emit', 'flush'])
  })

  it('give up on a part that runs past the deadline', async () => {
    const { sink } = recordingSink()
    const client = new Client({ sink, rateCap: createRateCap(1, 1) })
    client.addLifecycle({
      flush: () => new Promise<boolean>(() => undefined),
      close: async () => true
    })
    const startedAt = Date.now()
    expect(await client.flush(50)).toBe(false)
    expect(Date.now() - startedAt).toBeLessThan(500)
  })

  it('reports an extra whose getter throws without throwing itself', () => {
    const records = install()
    const extra = {
      get broken() {
        throw new Error('getter')
      }
    }
    expect(() =>
      captureException(new Error('x'), { extra: { extra } })
    ).not.toThrow()
    expect(records[0].attributes['extra.extra']).toBe(
      '{"broken":"[Unreadable]"}'
    )
  })

  it('flush and close the parts added to the client', async () => {
    const { sink } = recordingSink()
    const client = new Client({ sink, rateCap: createRateCap(1, 1) })
    const calls: string[] = []
    client.addLifecycle({
      flush: async () => {
        calls.push('flush')
        return true
      },
      close: async () => {
        calls.push('close')
        return true
      }
    })
    await client.flush()
    await client.close()
    expect(calls).toEqual(['flush', 'close'])
  })
})

describe('span events', () => {
  it('carry the scrubbed message, like the log record', () => {
    const records = install()
    const events: { name: string; attributes?: Record<string, unknown> }[] = []
    const span = {
      isRecording: () => true,
      spanContext: () => ({
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        traceFlags: 1
      }),
      addEvent: (name: string, attributes?: Record<string, unknown>) =>
        events.push({ name, attributes }),
      setStatus: () => undefined
    } as unknown as Span
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span)
    captureException(new Error('paid with 4111 1111 1111 1111'))
    expect(events[0].attributes?.['exception.message']).toBe(
      'paid with [Filtered]'
    )
    expect(records[0].attributes['exception.message']).toBe(
      'paid with [Filtered]'
    )
    vi.restoreAllMocks()
  })
})

describe('withScope', () => {
  it('keeps changes inside the callback', () => {
    const records = install()
    setTag('area', 'global')
    withScope((scope) => {
      scope.setTag('area', 'inner')
      captureMessage('inside', 'error')
    })
    captureMessage('outside', 'error')
    expect(records.map((record) => record.attributes.area)).toEqual([
      'inner',
      'global'
    ])
  })

  it('applies a capture context to one event only', () => {
    const records = install()
    captureException(new Error('one'), {
      tags: { once: 'yes' },
      level: 'fatal'
    })
    captureException(new Error('two'))
    expect(records[0]).toMatchObject({
      severityText: 'FATAL',
      attributes: { once: 'yes' }
    })
    expect(records[1].attributes.once).toBeUndefined()
  })
})
