package instatus

import (
	"context"
	"sync"
	"testing"
)

func resetGlobalScope(t *testing.T) {
	t.Helper()
	globalScope.Lock()
	globalScope.scope = newScope()
	globalScope.Unlock()
	t.Cleanup(func() {
		globalScope.Lock()
		globalScope.scope = newScope()
		globalScope.Unlock()
	})
}

func TestContextScopesAreIsolated(t *testing.T) {
	resetGlobalScope(t)
	parent := WithTag(context.Background(), "step", "charge")
	child := WithExtra(WithTag(parent, "region", "eu"), "retry", 2)

	if _, ok := currentScope(parent).tags["region"]; ok {
		t.Error("child tag leaked into parent")
	}
	scope := currentScope(child)
	if scope.tags["step"] != "charge" || scope.tags["region"] != "eu" || scope.extra["retry"] != 2 {
		t.Errorf("child scope = %#v", scope)
	}
	if len(currentScope(context.Background()).tags) != 0 {
		t.Error("background context has tags")
	}
}

func TestContextScopeWinsOverGlobal(t *testing.T) {
	resetGlobalScope(t)
	SetTag("plan", "free")
	SetUser(User{ID: "global"})
	SetContext("cart", Context{"items": 1})
	ctx := WithUser(WithTag(context.Background(), "plan", "pro"), User{ID: "request"})

	scope := currentScope(ctx)
	if scope.tags["plan"] != "pro" || scope.user.ID != "request" || scope.contexts["cart"]["items"] != 1 {
		t.Errorf("scope = %#v", scope)
	}
	SetTag("late", "yes")
	if currentScope(ctx).tags["late"] != "yes" {
		t.Error("global changes made later must apply to existing contexts")
	}
}

func TestWithScopeGivesACopy(t *testing.T) {
	resetGlobalScope(t)
	parent := WithContext(context.Background(), "job", Context{"id": "1"})
	child := WithScope(parent, func(scope *Scope) {
		scope.SetContext("job", nil)
		scope.SetTags(map[string]string{"queue": "mail"})
	})
	if _, ok := currentScope(child).contexts["job"]; ok {
		t.Error("context not removed in child")
	}
	if currentScope(parent).contexts["job"]["id"] != "1" {
		t.Error("parent changed by child")
	}
}

func TestEmptyUserClearsIt(t *testing.T) {
	resetGlobalScope(t)
	SetUser(User{ID: "1"})
	SetUser(User{})
	if currentScope(context.Background()).user != nil {
		t.Error("user not cleared")
	}
}

func TestEventValuesWinOverScope(t *testing.T) {
	scope := newScope()
	scope.SetTag("plan", "free")
	scope.SetTag("region", "eu")
	scope.SetUser(User{ID: "scope"})
	event := newEvent(LevelError)
	event.Tags["plan"] = "pro"
	event.User = &User{ID: "event"}
	scope.applyTo(event)
	if event.Tags["plan"] != "pro" || event.Tags["region"] != "eu" || event.User.ID != "event" {
		t.Errorf("event = %#v", event)
	}
}

func TestConcurrentRequestsKeepTheirOwnUser(t *testing.T) {
	resetGlobalScope(t)
	var wg sync.WaitGroup
	errs := make(chan string, 50)
	for index := range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := string(rune('a' + index%26))
			ctx := WithUser(context.Background(), User{ID: id})
			if got := currentScope(ctx).user.ID; got != id {
				errs <- got
			}
		}()
	}
	wg.Wait()
	close(errs)
	for got := range errs {
		t.Errorf("got user %q", got)
	}
}
