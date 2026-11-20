package instatus

import (
	"log/slog"

	"go.opentelemetry.io/contrib/bridges/otelslog"
)

const slogScope = "log/slog"

// NewSlogHandler returns a slog.Handler that sends records to Instatus Logs
// as OpenTelemetry log records, named after the instrumentation scope name.
// Records logged with a context carry its trace and span ids.
func NewSlogHandler(name string) slog.Handler {
	return otelslog.NewHandler(name)
}

// Logger returns a *slog.Logger that sends to Instatus Logs. It can be made
// before Init: records are dropped until Init sets the logger provider.
func Logger() *slog.Logger {
	return slog.New(NewSlogHandler(slogScope))
}
