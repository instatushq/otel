# frozen_string_literal: true

require "opentelemetry/sdk"
require "opentelemetry-logs-sdk"
require "opentelemetry-metrics-sdk"
require "opentelemetry/exporter/otlp"
require "opentelemetry-exporter-otlp-logs"
require "opentelemetry-exporter-otlp-metrics"

module Instatus
  module Otel
    class Providers
      SUCCESS = OpenTelemetry::SDK::Trace::Export::SUCCESS

      attr_reader :tracer_provider, :logger_provider, :meter_provider

      def initialize(config, env: ENV)
        @config = config
        exports = config.enabled? ? Exports.resolve(api_key: config.api_key, site_id: config.site_id, endpoint: config.endpoint, env: env) : {}
        warn("[instatus] init needs an api_key (or INSTATUS_API_KEY) or an OTLP endpoint") if config.enabled? && !exports[:logs]

        resource = build_resource
        @tracer_provider = build_tracer_provider(resource, exports[:traces])
        @logger_provider = build_logger_provider(resource, exports[:logs])
        @meter_provider = build_meter_provider(resource, exports[:metrics]) if exports[:metrics]
        @logger = @logger_provider.logger(name: SDK_NAME, version: VERSION)
      end

      def install
        OpenTelemetry.propagation = OpenTelemetry::Trace::Propagation::TraceContext.text_map_propagator
        OpenTelemetry.tracer_provider = tracer_provider
        OpenTelemetry.logger_provider = logger_provider
        OpenTelemetry.meter_provider = meter_provider if meter_provider
        install_instrumentations if @config.enabled?
        self
      end

      def emit(record, span_context)
        @logger.on_emit(
          timestamp: record.timestamp,
          observed_timestamp: Time.now,
          severity_number: record.severity_number,
          severity_text: record.severity_text,
          body: record.body,
          attributes: record.attributes,
          context: context_for(span_context)
        )
      end

      def flush(timeout)
        within(timeout) { |provider| provider.force_flush(timeout: timeout) }
      end

      def close(timeout)
        within(timeout) { |provider| provider.shutdown(timeout: timeout) }
      end

      private

      # Older metrics SDKs wait a whole export interval on shutdown, whatever the timeout.
      def within(timeout)
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
        threads = each_provider.map do |provider|
          Thread.new { yield(provider) }.tap { |thread| thread.report_on_exception = false }
        end
        threads.all? do |thread|
          remaining = [deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC), 0].max
          thread.join(remaining) && thread.value == SUCCESS
        rescue StandardError
          false
        end
      end

      def each_provider
        [logger_provider, tracer_provider, meter_provider].compact
      end

      def context_for(span_context)
        return OpenTelemetry::Context.empty unless span_context&.valid?

        OpenTelemetry::Trace.context_with_span(OpenTelemetry::Trace.non_recording_span(span_context), parent_context: OpenTelemetry::Context.empty)
      end

      def build_resource
        attributes = Resource.attributes(service_name: @config.service_name, release: @config.release, environment: @config.environment)
        OpenTelemetry::SDK::Resources::Resource.default
          .merge(OpenTelemetry::SDK::Resources::Resource.create(Resource.host_attributes))
          .merge(OpenTelemetry::SDK::Resources::Resource.create(attributes))
      end

      def build_tracer_provider(resource, target)
        sampler = OpenTelemetry::SDK::Trace::Samplers.parent_based(
          root: OpenTelemetry::SDK::Trace::Samplers.trace_id_ratio_based(@config.traces_sample_rate.to_f)
        )
        provider = OpenTelemetry::SDK::Trace::TracerProvider.new(resource: resource, sampler: sampler)
        if target
          exporter = OpenTelemetry::Exporter::OTLP::Exporter.new(**target.exporter_options)
          provider.add_span_processor(OpenTelemetry::SDK::Trace::Export::BatchSpanProcessor.new(exporter))
        end
        provider
      end

      def build_logger_provider(resource, target)
        provider = OpenTelemetry::SDK::Logs::LoggerProvider.new(resource: resource)
        if target
          exporter = OpenTelemetry::Exporter::OTLP::Logs::LogsExporter.new(**target.exporter_options)
          provider.add_log_record_processor(OpenTelemetry::SDK::Logs::Export::BatchLogRecordProcessor.new(exporter))
        end
        provider
      end

      def build_meter_provider(resource, target)
        provider = OpenTelemetry::SDK::Metrics::MeterProvider.new(resource: resource)
        exporter = OpenTelemetry::Exporter::OTLP::Metrics::MetricsExporter.new(**target.exporter_options)
        interval = (@config.metrics_export_interval.to_f * 1000).to_i
        provider.add_metric_reader(
          OpenTelemetry::SDK::Metrics::Export::PeriodicMetricReader.new(exporter: exporter, export_interval_millis: interval)
        )
        provider
      end

      def install_instrumentations
        instrumentations = @config.instrumentations
        return unless instrumentations

        registry = OpenTelemetry::Instrumentation.registry
        case instrumentations
        when :all, true then registry.install_all
        when Hash then registry.install(instrumentations.keys, instrumentations)
        else registry.install(Array(instrumentations))
        end
      end
    end
  end
end
