package instatus

import (
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"strings"
	"testing"
)

// The same checks as detectStackLanguage in the backend's
// issues/helpers/stack-frames.ts.
var (
	backendGoroutineHeader = regexp.MustCompile(`(?m)^goroutine \d+ \[`)
	backendGoLocation      = regexp.MustCompile(`(?m)^\t.*\.go:\d+`)
	backendPythonOrNative  = regexp.MustCompile(`Traceback \(most recent call last\)|(?m)^\s*File ".*", line \d+|(?m)^\d+\t[^\t]+\t0x[0-9a-fA-F]+\t`)
)

func detectedAsGo(stack string) bool {
	if backendPythonOrNative.MatchString(stack) {
		return false
	}
	return backendGoroutineHeader.MatchString(stack) || backendGoLocation.MatchString(stack)
}

type quotaError struct{ limit int }

func (e quotaError) Error() string { return fmt.Sprintf("quota of %d reached", e.limit) }

func TestExceptionType(t *testing.T) {
	pathErr := &fs.PathError{Op: "open", Path: "/x", Err: fs.ErrNotExist}
	cases := []struct {
		want string
		err  error
	}{
		{"*errors.errorString", errors.New("plain")},
		{"*fs.PathError", fmt.Errorf("load config: %w", pathErr)},
		{"instatus.quotaError", fmt.Errorf("a: %w", fmt.Errorf("b: %w", quotaError{3}))},
		{"*fs.PathError", errors.Join(pathErr, errors.New("other"))},
	}
	for _, c := range cases {
		if got := exceptionType(c.err); got != c.want {
			t.Errorf("exceptionType(%v) = %q, want %q", c.err, got, c.want)
		}
	}
}

func TestEventFromErrorKeepsTheWholeMessage(t *testing.T) {
	err := fmt.Errorf("load config: %w", &fs.PathError{Op: "open", Path: "/x", Err: fs.ErrNotExist})
	event := eventFromError(err, true, LevelError)
	if event.Exception.Value != "load config: open /x: file does not exist" || !event.Exception.Handled {
		t.Errorf("exception = %#v", event.Exception)
	}
	if len(event.EventID) != 32 {
		t.Errorf("event id = %q", event.EventID)
	}
}

func TestCallerStackIsGoStackWithoutSDKFrames(t *testing.T) {
	stack := eventFromError(errors.New("boom"), true, LevelError).Exception.Stacktrace
	if !detectedAsGo(stack) {
		t.Fatalf("not detected as go:\n%s", stack)
	}
	lines := strings.Split(stack, "\n")
	if !strings.HasPrefix(lines[0], "goroutine ") {
		t.Errorf("header = %q", lines[0])
	}
	if !strings.HasPrefix(lines[1], "testing.tRunner(") {
		t.Errorf("first frame = %q, want the caller outside the SDK", lines[1])
	}
	if strings.Contains(stack, "runtime/debug.Stack") || strings.Contains(stack, SDKName+".eventFromError") {
		t.Errorf("SDK frames kept:\n%s", stack)
	}
}

func TestTrimSDKFrames(t *testing.T) {
	stack := strings.Join([]string{
		"goroutine 7 [running]:",
		"runtime/debug.Stack()",
		"\t/usr/local/go/src/runtime/debug/stack.go:26 +0x5e",
		"github.com/instatushq/otel/go.(*pipeline).capture(0xc000010000)",
		"\t/sdk/client.go:10 +0x1",
		"panic({0x5b33cc0?, 0x5c2da40?})",
		"\t/usr/local/go/src/runtime/panic.go:785 +0x132",
		"main.handler({0x1, 0x2})",
		"\t/app/main.go:12 +0x1d",
		"",
	}, "\n")
	want := "goroutine 7 [running]:\nmain.handler({0x1, 0x2})\n\t/app/main.go:12 +0x1d\n"
	if got := trimSDKFrames(stack); got != want {
		t.Errorf("got %q", got)
	}
	if got := trimSDKFrames("not a stack"); got != "not a stack" {
		t.Errorf("non-stack changed: %q", got)
	}
}

func TestExceptionFromRecovered(t *testing.T) {
	if got := exceptionFromRecovered("nil map"); got.Type != "panic" || got.Value != "nil map" {
		t.Errorf("string panic = %#v", got)
	}
	var values []int
	func() {
		defer func() {
			got := exceptionFromRecovered(recover())
			if got.Type != "runtime.boundsError" || !strings.HasPrefix(got.Value, "runtime error: index out of range") {
				t.Errorf("runtime panic = %#v", got)
			}
		}()
		_ = values[3]
	}()
}
