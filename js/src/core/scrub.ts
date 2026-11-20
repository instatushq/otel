export const FILTERED = '[Filtered]'

const SENSITIVE_KEY =
  /pass(word|wd)?|secret|token|api[-_.]?key|auth|credential|session|cookie|csrf|xsrf|private[-_.]?key|signature/i
const CARD_NUMBER = /\b\d(?:[ -]?\d){12,18}\b/g
const URL_CREDENTIALS = /^([a-z][a-z0-9+.-]*:\/\/)[^/@?#]*@/i
const URL_PARAM = /([?&#])([^=&#]+)=([^&#]*)/g

export const isSensitiveKey = (key: string) => SENSITIVE_KEY.test(key)

const decode = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

// OAuth redirects put tokens in the hash as well as the query.
// A card number can sit in any parameter (?number=4111…), not only under a
// secret-sounding name, so URLs get the text filter too.
export const scrubUrl = (url: string) =>
  scrubText(
    url
      .replace(URL_CREDENTIALS, '$1')
      .replace(URL_PARAM, (match, separator: string, key: string) =>
        isSensitiveKey(decode(key)) ? `${separator}${key}=${FILTERED}` : match
      )
  )

// The Luhn check keeps timestamps and order numbers of card length.
const passesLuhn = (digits: string) => {
  let sum = 0
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index])
    if (index % 2 === 1) digit *= 2
    if (digit > 9) digit -= 9
    sum += digit
  }
  return sum % 10 === 0
}

export const scrubText = (text: string) =>
  text.replace(CARD_NUMBER, (match) =>
    passesLuhn(match.replace(/\D/g, '')) ? FILTERED : match
  )

const MAX_DEPTH = 6

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// Walks objects and arrays, since an extra or context value is serialized
// whole: { request: { password } } must lose the password too.
const UNREADABLE = '[Unreadable]'

// A getter that throws must not turn reporting one error into a second one.
const readProperty = (value: object, key: string | number): unknown => {
  try {
    return (value as Record<string | number, unknown>)[key]
  } catch {
    return UNREADABLE
  }
}

const mapChildren = (
  value: object,
  scrubChild: (childKey: string) => unknown
) => {
  if (Array.isArray(value)) {
    return value.map((_, index) => scrubChild(String(index)))
  }
  return Object.fromEntries(
    Object.keys(value).map((childKey) => [childKey, scrubChild(childKey)])
  )
}

// ancestors holds the objects on the current path only, so a value used
// twice (billing and shipping address) is kept and only a real cycle is cut.
const scrubNested = (
  key: string,
  value: unknown,
  depth: number,
  ancestors: Set<object>
): unknown => {
  if (isSensitiveKey(key)) return FILTERED
  if (typeof value === 'string') return scrubText(value)
  if (!Array.isArray(value) && !isPlainObject(value)) return value
  if (ancestors.has(value)) return '[Circular]'
  if (depth >= MAX_DEPTH) return '[Truncated]'
  ancestors.add(value)
  const scrubChild = (childKey: string) =>
    scrubNested(childKey, readProperty(value, childKey), depth + 1, ancestors)
  const scrubbed = mapChildren(value, scrubChild)
  ancestors.delete(value)
  return scrubbed
}

export const scrubValue = (key: string, value: unknown): unknown =>
  scrubNested(key, value, 0, new Set())
