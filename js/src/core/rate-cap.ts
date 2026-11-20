export type RateCap = { take: () => boolean }

// windowMs of Infinity caps a whole page load, which is what the browser uses.
export const createRateCap = (
  limit: number,
  windowMs: number,
  now: () => number = Date.now
): RateCap => {
  let windowStart = now()
  let count = 0
  return {
    take: () => {
      const time = now()
      if (time - windowStart >= windowMs) {
        windowStart = time
        count = 0
      }
      if (count >= limit) return false
      count += 1
      return true
    }
  }
}
