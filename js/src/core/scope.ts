import type {
  Breadcrumb,
  CaptureContext,
  Context,
  Primitive,
  SeverityLevel,
  User
} from './types'

export const DEFAULT_MAX_BREADCRUMBS = 30

export class Scope {
  user?: User
  level?: SeverityLevel
  tags: Record<string, Primitive> = {}
  extra: Record<string, unknown> = {}
  contexts: Record<string, Context> = {}
  breadcrumbs: Breadcrumb[] = []
  maxBreadcrumbs = DEFAULT_MAX_BREADCRUMBS

  clone() {
    const copy = new Scope()
    copy.user = this.user
    copy.level = this.level
    copy.tags = { ...this.tags }
    copy.extra = { ...this.extra }
    copy.contexts = { ...this.contexts }
    copy.breadcrumbs = [...this.breadcrumbs]
    copy.maxBreadcrumbs = this.maxBreadcrumbs
    return copy
  }

  setUser(user: User | null) {
    this.user = user ?? undefined
    return this
  }

  setTag(key: string, value: Primitive) {
    this.tags[key] = value
    return this
  }

  setTags(tags: Record<string, Primitive>) {
    Object.assign(this.tags, tags)
    return this
  }

  setExtra(key: string, value: unknown) {
    this.extra[key] = value
    return this
  }

  setExtras(extras: Record<string, unknown>) {
    Object.assign(this.extra, extras)
    return this
  }

  setContext(name: string, context: Context | null) {
    if (context === null) delete this.contexts[name]
    else this.contexts[name] = context
    return this
  }

  setLevel(level: SeverityLevel) {
    this.level = level
    return this
  }

  addBreadcrumb(breadcrumb: Breadcrumb) {
    this.breadcrumbs.push(breadcrumb)
    if (this.breadcrumbs.length > this.maxBreadcrumbs) {
      this.breadcrumbs.splice(0, this.breadcrumbs.length - this.maxBreadcrumbs)
    }
    return this
  }

  clearBreadcrumbs() {
    this.breadcrumbs = []
    return this
  }

  update(context: CaptureContext) {
    if (context.user) this.setUser(context.user)
    if (context.tags) this.setTags(context.tags)
    if (context.extra) this.setExtras(context.extra)
    if (context.level) this.setLevel(context.level)
    for (const [name, value] of Object.entries(context.contexts ?? {})) {
      this.setContext(name, value)
    }
    return this
  }

  clear() {
    this.user = undefined
    this.level = undefined
    this.tags = {}
    this.extra = {}
    this.contexts = {}
    this.breadcrumbs = []
    return this
  }
}
