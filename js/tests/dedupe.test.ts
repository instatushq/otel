import { describe, expect, it } from 'vitest'
import { createDedupe, markCaptured, wasCaptured } from '../src/core/dedupe'
import { eventFromException, eventFromMessage } from '../src/core/event'
import { createRateCap } from '../src/core/rate-cap'

const mechanism = { type: 'generic', handled: true }

describe('createDedupe', () => {
  it('drops an event identical to the one just sent', () => {
    const isDuplicate = createDedupe()
    const error = new Error('same')
    expect(isDuplicate(eventFromException(error, mechanism))).toBe(false)
    expect(isDuplicate(eventFromException(error, mechanism))).toBe(true)
  })

  it('lets the same error through again after a different one', () => {
    const isDuplicate = createDedupe()
    const first = new Error('first')
    expect(isDuplicate(eventFromException(first, mechanism))).toBe(false)
    expect(
      isDuplicate(eventFromException(new Error('second'), mechanism))
    ).toBe(false)
    expect(isDuplicate(eventFromException(first, mechanism))).toBe(false)
  })

  it('tells messages apart by text', () => {
    const isDuplicate = createDedupe()
    expect(isDuplicate(eventFromMessage('a', 'info'))).toBe(false)
    expect(isDuplicate(eventFromMessage('b', 'info'))).toBe(false)
    expect(isDuplicate(eventFromMessage('b', 'info'))).toBe(true)
  })
})

describe('markCaptured', () => {
  it('remembers an error object without changing what it serializes to', () => {
    const error = new Error('x')
    expect(wasCaptured(error)).toBe(false)
    markCaptured(error)
    expect(wasCaptured(error)).toBe(true)
    expect(Object.keys(error)).toEqual([])
    expect(wasCaptured('a string')).toBe(false)
  })
})

describe('createRateCap', () => {
  it('caps a page load when the window never ends', () => {
    const cap = createRateCap(2, Number.POSITIVE_INFINITY)
    expect([cap.take(), cap.take(), cap.take()]).toEqual([true, true, false])
  })

  it('starts over each window', () => {
    let now = 0
    const cap = createRateCap(1, 1000, () => now)
    expect(cap.take()).toBe(true)
    expect(cap.take()).toBe(false)
    now = 1000
    expect(cap.take()).toBe(true)
  })
})
