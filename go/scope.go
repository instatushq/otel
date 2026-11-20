package instatus

import (
	"context"
	"maps"
	"sync"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// Scope holds the user, tags, contexts and extras sent with each event.
// A Scope on a context.Context applies to that request only, on top of the
// global one.
type Scope struct {
	user     *User
	tags     map[string]string
	contexts map[string]Context
	extra    map[string]any
}

func newScope() *Scope {
	return &Scope{
		tags:     map[string]string{},
		contexts: map[string]Context{},
		extra:    map[string]any{},
	}
}

func (s *Scope) clone() *Scope {
	copied := &Scope{
		tags:     maps.Clone(s.tags),
		contexts: maps.Clone(s.contexts),
		extra:    maps.Clone(s.extra),
	}
	if s.user != nil {
		user := *s.user
		copied.user = &user
	}
	return copied
}

// SetUser sets who is affected. An empty User clears it.
func (s *Scope) SetUser(user User) {
	if user.isZero() {
		s.user = nil
		return
	}
	s.user = &user
}

// SetTag adds an attribute you can filter by.
func (s *Scope) SetTag(key, value string) {
	s.tags[key] = value
}

// SetTags adds several tags.
func (s *Scope) SetTags(tags map[string]string) {
	maps.Copy(s.tags, tags)
}

// SetContext adds a group of details, sent as name.key attributes. A nil
// context removes it.
func (s *Scope) SetContext(name string, values Context) {
	if values == nil {
		delete(s.contexts, name)
		return
	}
	s.contexts[name] = maps.Clone(values)
}

// SetExtra adds a detail, sent as extra.key.
func (s *Scope) SetExtra(key string, value any) {
	s.extra[key] = value
}

func (s *Scope) overlay(top *Scope) {
	if top.user != nil {
		user := *top.user
		s.user = &user
	}
	maps.Copy(s.tags, top.tags)
	maps.Copy(s.contexts, top.contexts)
	maps.Copy(s.extra, top.extra)
}

// Event values win over the scope's, as in Sentry.
func (s *Scope) applyTo(event *Event) {
	if event.User == nil && s.user != nil {
		user := *s.user
		event.User = &user
	}
	event.Tags = mergeUnder(s.tags, event.Tags)
	event.Contexts = mergeUnder(s.contexts, event.Contexts)
	event.Extra = mergeUnder(s.extra, event.Extra)
}

func mergeUnder[V any](base, top map[string]V) map[string]V {
	merged := maps.Clone(base)
	if merged == nil {
		merged = map[string]V{}
	}
	maps.Copy(merged, top)
	return merged
}

type scopeKey struct{}

var globalScope = struct {
	sync.RWMutex
	scope *Scope
}{scope: newScope()}

func configureGlobal(change func(*Scope)) {
	globalScope.Lock()
	defer globalScope.Unlock()
	change(globalScope.scope)
}

func scopeFromContext(ctx context.Context) *Scope {
	if ctx == nil {
		return nil
	}
	scope, _ := ctx.Value(scopeKey{}).(*Scope)
	return scope
}

// currentScope is the global scope with the context's scope on top.
func currentScope(ctx context.Context) *Scope {
	globalScope.RLock()
	merged := globalScope.scope.clone()
	globalScope.RUnlock()
	if scope := scopeFromContext(ctx); scope != nil {
		merged.overlay(scope)
	}
	return merged
}

// WithScope returns a context whose scope is a copy of ctx's, changed by
// configure. Events captured with it carry the changes; ctx is untouched.
func WithScope(ctx context.Context, configure func(scope *Scope)) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	scope := newScope()
	if existing := scopeFromContext(ctx); existing != nil {
		scope = existing.clone()
	}
	configure(scope)
	return context.WithValue(ctx, scopeKey{}, scope)
}

// WithUser returns a context whose events are about user. The active span
// gets enduser.id too.
func WithUser(ctx context.Context, user User) context.Context {
	scoped := WithScope(ctx, func(scope *Scope) { scope.SetUser(user) })
	span := trace.SpanFromContext(scoped)
	if id := endUserID(&user); id != "" && span.IsRecording() {
		span.SetAttributes(attribute.String("enduser.id", id))
	}
	return scoped
}

// WithTag returns a context whose events carry the tag.
func WithTag(ctx context.Context, key, value string) context.Context {
	return WithScope(ctx, func(scope *Scope) { scope.SetTag(key, value) })
}

// WithTags returns a context whose events carry the tags.
func WithTags(ctx context.Context, tags map[string]string) context.Context {
	return WithScope(ctx, func(scope *Scope) { scope.SetTags(tags) })
}

// WithContext returns a context whose events carry the name.key attributes.
func WithContext(ctx context.Context, name string, values Context) context.Context {
	return WithScope(ctx, func(scope *Scope) { scope.SetContext(name, values) })
}

// WithExtra returns a context whose events carry extra.key.
func WithExtra(ctx context.Context, key string, value any) context.Context {
	return WithScope(ctx, func(scope *Scope) { scope.SetExtra(key, value) })
}

// ConfigureScope changes the global scope, which every event carries.
func ConfigureScope(configure func(scope *Scope)) {
	configureGlobal(configure)
}

// SetUser sets the user on the global scope. An empty User clears it.
func SetUser(user User) {
	configureGlobal(func(scope *Scope) { scope.SetUser(user) })
}

// SetTag sets a tag on the global scope.
func SetTag(key, value string) {
	configureGlobal(func(scope *Scope) { scope.SetTag(key, value) })
}

// SetTags sets tags on the global scope.
func SetTags(tags map[string]string) {
	configureGlobal(func(scope *Scope) { scope.SetTags(tags) })
}

// SetContext sets a context on the global scope. A nil context removes it.
func SetContext(name string, values Context) {
	configureGlobal(func(scope *Scope) { scope.SetContext(name, values) })
}

// SetExtra sets an extra on the global scope.
func SetExtra(key string, value any) {
	configureGlobal(func(scope *Scope) { scope.SetExtra(key, value) })
}
