package instatus

import (
	"context"
	"reflect"
	"testing"

	"go.opentelemetry.io/otel/attribute"
)

func envOf(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestAPIKeySendsEverySignalToTheCollector(t *testing.T) {
	got := resolveExports(Options{APIKey: "sk_1", SiteID: "site_1"}, envOf(nil))
	headers := map[string]string{"Authorization": "Bearer sk_1", "X-Instatus-Site-Id": "site_1"}
	want := exports{
		signalLogs:    {URL: "https://otel.instatus.com/v1/logs", Headers: headers},
		signalTraces:  {URL: "https://otel.instatus.com/v1/traces", Headers: headers},
		signalMetrics: {URL: "https://otel.instatus.com/v1/metrics", Headers: headers},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %#v", got)
	}
}

func TestKeyAndSiteFallBackToEnvironment(t *testing.T) {
	got := resolveExports(Options{}, envOf(map[string]string{"INSTATUS_API_KEY": "sk_env", "INSTATUS_SITE_ID": "site_env"}))
	headers := got[signalLogs].Headers
	if headers["Authorization"] != "Bearer sk_env" || headers["X-Instatus-Site-Id"] != "site_env" {
		t.Errorf("headers = %#v", headers)
	}
}

func TestSiteHeaderNeedsASiteID(t *testing.T) {
	headers := resolveExports(Options{APIKey: "sk_1"}, envOf(nil))[signalTraces].Headers
	if _, ok := headers["X-Instatus-Site-Id"]; ok || len(headers) != 1 {
		t.Errorf("headers = %#v", headers)
	}
}

func TestEndpointReplacesTheHost(t *testing.T) {
	got := resolveExports(Options{APIKey: "sk_1", Endpoint: "http://localhost:4318/"}, envOf(nil))
	if got[signalMetrics].URL != "http://localhost:4318/v1/metrics" {
		t.Errorf("url = %q", got[signalMetrics].URL)
	}
	withoutKey := resolveExports(Options{Endpoint: "http://localhost:4318"}, envOf(nil))
	if withoutKey[signalLogs].URL != "http://localhost:4318/v1/logs" || len(withoutKey[signalLogs].Headers) != 0 {
		t.Errorf("endpoint without key = %#v", withoutKey[signalLogs])
	}
}

func TestStandardOTLPVariablesApplyWithoutAnEndpoint(t *testing.T) {
	withKey := resolveExports(Options{APIKey: "sk_1"}, envOf(map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector:4318"}))
	if withKey[signalLogs].URL != "" || withKey[signalLogs].Headers["Authorization"] != "Bearer sk_1" {
		t.Errorf("env endpoint with key = %#v", withKey[signalLogs])
	}
	tracesOnly := resolveExports(Options{}, envOf(map[string]string{"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": "http://collector:4318/v1/traces"}))
	if want := (exports{signalTraces: {}}); !reflect.DeepEqual(tracesOnly, want) {
		t.Errorf("traces only = %#v", tracesOnly)
	}
	if nothing := resolveExports(Options{}, envOf(nil)); len(nothing) != 0 {
		t.Errorf("nothing configured = %#v", nothing)
	}
}

func resourceValue(t *testing.T, options Options, key string) string {
	t.Helper()
	value, ok := buildResource(context.Background(), options).Set().Value(attribute.Key(key))
	if !ok {
		return ""
	}
	return value.Emit()
}

func TestResource(t *testing.T) {
	t.Setenv("OTEL_SERVICE_NAME", "")
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "team=core")
	options := Options{Release: "api@1.2.0", Environment: "production"}
	want := map[string]string{
		"service.name":                "go.test",
		"service.version":             "api@1.2.0",
		"deployment.environment.name": "production",
		"telemetry.sdk.name":          "github.com/instatushq/otel/go",
		"telemetry.sdk.version":       Version,
		"telemetry.sdk.language":      "go",
		"team":                        "core",
	}
	for key, value := range want {
		if got := resourceValue(t, options, key); got != value {
			t.Errorf("%s = %q, want %q", key, got, value)
		}
	}
	if resourceValue(t, options, "host.name") == "" || resourceValue(t, options, "process.pid") == "" {
		t.Error("host and process detectors missing")
	}
	if resourceValue(t, options, "process.command_args") != "" {
		t.Error("command-line arguments must be left out")
	}
}

func TestServiceNamePrecedence(t *testing.T) {
	t.Setenv("OTEL_SERVICE_NAME", "from-env")
	if got := resourceValue(t, Options{}, "service.name"); got != "from-env" {
		t.Errorf("env service name = %q", got)
	}
	if got := resourceValue(t, Options{ServiceName: "checkout"}, "service.name"); got != "checkout" {
		t.Errorf("option service name = %q", got)
	}
}
