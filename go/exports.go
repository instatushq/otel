package instatus

import (
	"strings"
)

// DefaultEndpoint is the Instatus collector, which takes secret API keys.
const DefaultEndpoint = "https://otel.instatus.com"

type signal string

const (
	signalLogs    signal = "logs"
	signalTraces  signal = "traces"
	signalMetrics signal = "metrics"
)

var signals = []signal{signalLogs, signalTraces, signalMetrics}

// An empty URL leaves the OTLP exporter to read OTEL_EXPORTER_OTLP_* itself.
type signalExport struct {
	URL     string
	Headers map[string]string
}

type exports map[signal]signalExport

func hasEnvEndpoint(getenv func(string) string, target signal) bool {
	return getenv("OTEL_EXPORTER_OTLP_"+strings.ToUpper(string(target))+"_ENDPOINT") != "" ||
		getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != ""
}

func signalURL(endpoint string, target signal) string {
	return strings.TrimRight(endpoint, "/") + "/v1/" + string(target)
}

func urlFor(endpoint string, getenv func(string) string, target signal) string {
	if endpoint != "" {
		return signalURL(endpoint, target)
	}
	if hasEnvEndpoint(getenv, target) {
		return ""
	}
	return signalURL(DefaultEndpoint, target)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// An API key sends every signal to the collector. Without one, only an
// endpoint or the standard OTEL_EXPORTER_OTLP_* variables export anything.
func resolveExports(options Options, getenv func(string) string) exports {
	apiKey := firstNonEmpty(options.APIKey, getenv("INSTATUS_API_KEY"))
	siteID := firstNonEmpty(options.SiteID, getenv("INSTATUS_SITE_ID"))
	resolved := exports{}
	if apiKey != "" {
		headers := map[string]string{"Authorization": "Bearer " + apiKey}
		if siteID != "" {
			headers["X-Instatus-Site-Id"] = siteID
		}
		for _, target := range signals {
			resolved[target] = signalExport{URL: urlFor(options.Endpoint, getenv, target), Headers: headers}
		}
		return resolved
	}
	for _, target := range signals {
		if options.Endpoint != "" {
			resolved[target] = signalExport{URL: signalURL(options.Endpoint, target)}
		} else if hasEnvEndpoint(getenv, target) {
			resolved[target] = signalExport{}
		}
	}
	return resolved
}
