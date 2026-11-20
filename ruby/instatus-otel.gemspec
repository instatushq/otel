# frozen_string_literal: true

require_relative "lib/instatus/otel/version"

Gem::Specification.new do |spec|
  spec.name = "instatus-otel"
  spec.version = Instatus::Otel::VERSION
  spec.authors = ["Instatus"]
  spec.summary = "Error tracking on OpenTelemetry, with the Sentry SDK's API."
  spec.description = "An OpenTelemetry distro for Ruby that sends errors, logs, traces and metrics to Instatus. " \
                     "Errors are OpenTelemetry log records, captured with Sentry-style functions."
  spec.homepage = "https://github.com/instatushq/otel"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.1"

  spec.metadata = {
    "homepage_uri" => spec.homepage,
    "source_code_uri" => "https://github.com/instatushq/otel/tree/main/ruby",
    "bug_tracker_uri" => "https://github.com/instatushq/otel/issues",
    "rubygems_mfa_required" => "true"
  }

  spec.files = Dir["lib/**/*.rb"] + %w[README.md LICENSE]
  spec.require_paths = ["lib"]

  spec.add_dependency "opentelemetry-exporter-otlp", ">= 0.30", "< 1"
  spec.add_dependency "opentelemetry-exporter-otlp-logs", ">= 0.2", "< 1"
  spec.add_dependency "opentelemetry-exporter-otlp-metrics", ">= 0.4", "< 1"
  spec.add_dependency "opentelemetry-logs-sdk", ">= 0.2", "< 1"
  spec.add_dependency "opentelemetry-metrics-sdk", ">= 0.6", "< 1"
  spec.add_dependency "opentelemetry-sdk", "~> 1.8"
end
