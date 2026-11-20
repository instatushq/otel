package instatus

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"reflect"
	"regexp"
	"runtime/debug"
	"strings"
	"time"
)

// Level is a Sentry severity level.
type Level string

const (
	LevelDebug   Level = "debug"
	LevelInfo    Level = "info"
	LevelWarning Level = "warning"
	LevelError   Level = "error"
	LevelFatal   Level = "fatal"
)

// Context is a group of details set with SetContext, sent as name.key attributes.
type Context = map[string]any

// User is who an error affected. ID, else Email, else Username, becomes enduser.id.
type User struct {
	ID        string
	Email     string
	Username  string
	IPAddress string
	Data      map[string]string
}

func (u User) isZero() bool {
	return u.ID == "" && u.Email == "" && u.Username == "" && u.IPAddress == "" && len(u.Data) == 0
}

// Exception is the error an event reports. Stacktrace is Go's own stack text.
type Exception struct {
	Type       string
	Value      string
	Stacktrace string
	Handled    bool
}

// Event is what BeforeSend receives, before the filters run.
type Event struct {
	EventID   string
	Timestamp time.Time
	Level     Level
	Message   string
	Exception *Exception
	User      *User
	Tags      map[string]string
	Contexts  map[string]Context
	Extra     map[string]any
}

// EventHint carries what an event was built from.
type EventHint struct {
	Context            context.Context
	OriginalException  error
	RecoveredException any
}

const (
	panicType        = "panic"
	maxUnwrapDepth   = 100
	defaultErrorType = "Error"
)

var goroutineHeader = regexp.MustCompile(`^goroutine \d+ \[`)

// Wrappers from fmt.Errorf and errors.Join say nothing about the error, so
// exception.type names the first error in the chain that isn't one.
var genericWrappers = map[string]bool{
	"*fmt.wrapError":    true,
	"*fmt.wrapErrors":   true,
	"*errors.joinError": true,
}

func newEventID() string {
	bytes := make([]byte, 16)
	_, _ = rand.Read(bytes)
	return hex.EncodeToString(bytes)
}

func newEvent(level Level) *Event {
	return &Event{
		EventID:   newEventID(),
		Timestamp: time.Now(),
		Level:     level,
		Tags:      map[string]string{},
		Contexts:  map[string]Context{},
		Extra:     map[string]any{},
	}
}

func unwrapFirst(err error) error {
	switch wrapped := err.(type) {
	case interface{ Unwrap() error }:
		return wrapped.Unwrap()
	case interface{ Unwrap() []error }:
		if errs := wrapped.Unwrap(); len(errs) > 0 {
			return errs[0]
		}
	}
	return nil
}

func exceptionType(err error) string {
	current := err
	for depth := 0; current != nil && depth < maxUnwrapDepth; depth++ {
		name := reflect.TypeOf(current).String()
		if !genericWrappers[name] {
			return name
		}
		current = unwrapFirst(current)
	}
	return reflect.TypeOf(err).String()
}

func exceptionFromRecovered(recovered any) *Exception {
	if err, ok := recovered.(error); ok {
		return &Exception{Type: exceptionType(err), Value: err.Error()}
	}
	return &Exception{Type: panicType, Value: fmt.Sprint(recovered)}
}

func isSDKFrame(line string) bool {
	return strings.HasPrefix(line, "runtime/debug.Stack(") || strings.HasPrefix(line, SDKName+".")
}

// Drops the frames of debug.Stack, this package and, after Recover, panic
// itself, so the stack starts where the app called in or panicked.
func trimSDKFrames(stack string) string {
	lines := strings.Split(strings.TrimRight(stack, "\n"), "\n")
	if len(lines) < 3 || !goroutineHeader.MatchString(lines[0]) {
		return stack
	}
	start := 1
	for start+1 < len(lines) && isSDKFrame(lines[start]) {
		start += 2
	}
	if start+1 < len(lines) && strings.HasPrefix(lines[start], "panic(") {
		start += 2
	}
	kept := append([]string{lines[0]}, lines[start:]...)
	return strings.Join(kept, "\n") + "\n"
}

func callerStack() string {
	return trimSDKFrames(string(debug.Stack()))
}

func eventFromError(err error, handled bool, level Level) *Event {
	event := newEvent(level)
	event.Exception = &Exception{
		Type:       exceptionType(err),
		Value:      err.Error(),
		Stacktrace: callerStack(),
		Handled:    handled,
	}
	return event
}

func eventFromRecovered(recovered any) *Event {
	event := newEvent(LevelFatal)
	event.Exception = exceptionFromRecovered(recovered)
	event.Exception.Stacktrace = callerStack()
	return event
}

func eventFromMessage(message string, level Level) *Event {
	event := newEvent(level)
	event.Message = message
	return event
}
