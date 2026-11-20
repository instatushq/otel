package instatus

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/resource"
)

const (
	language            = "go"
	fallbackServiceName = "go"
)

func defaultServiceName() string {
	executable, err := os.Executable()
	if err != nil {
		return fallbackServiceName
	}
	name := strings.TrimSuffix(filepath.Base(executable), ".exe")
	return firstNonEmpty(name, fallbackServiceName)
}

// Sentry's release and environment are OpenTelemetry resource attributes.
func resourceAttributes(options Options) []attribute.KeyValue {
	attributes := []attribute.KeyValue{
		attribute.String("telemetry.sdk.name", SDKName),
		attribute.String("telemetry.sdk.version", Version),
		attribute.String("telemetry.sdk.language", language),
	}
	if options.ServiceName != "" {
		attributes = append(attributes, attribute.String("service.name", options.ServiceName))
	}
	if options.Release != "" {
		attributes = append(attributes, attribute.String("service.version", options.Release))
	}
	if options.Environment != "" {
		attributes = append(attributes, attribute.String("deployment.environment.name", options.Environment))
	}
	return attributes
}

// Later sources win: the executable's name, then OTEL_SERVICE_NAME and
// OTEL_RESOURCE_ATTRIBUTES, then the options. Command-line arguments are
// left out because they often carry secrets.
func buildResource(ctx context.Context, options Options) *resource.Resource {
	detected, _ := resource.New(ctx,
		resource.WithAttributes(attribute.String("service.name", defaultServiceName())),
		resource.WithFromEnv(),
		resource.WithHost(),
		resource.WithOSType(),
		resource.WithProcessPID(),
		resource.WithProcessExecutableName(),
		resource.WithProcessExecutablePath(),
		resource.WithProcessOwner(),
		resource.WithProcessRuntimeName(),
		resource.WithProcessRuntimeVersion(),
		resource.WithProcessRuntimeDescription(),
		resource.WithAttributes(resourceAttributes(options)...),
	)
	if detected == nil {
		return resource.NewSchemaless(resourceAttributes(options)...)
	}
	return detected
}
