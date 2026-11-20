# frozen_string_literal: true

require "opentelemetry"

module Instatus
  module Otel
    class Client
      SPAN_EVENT_KEYS = %w[exception.type exception.message exception.stacktrace].freeze

      attr_reader :config

      def initialize(config, sink:, rate_cap: RateCap.new(config.max_events_per_minute, 60))
        @config = config
        @sink = sink
        @rate_cap = rate_cap
        @dedupe = Dedupe.new
      end

      def capture_event(event, hint = {})
        dropped = drop_reason(event, hint)
        if dropped
          log("dropped an event: #{dropped}")
          return event.event_id
        end

        Dedupe.mark_captured(hint[:exception])
        span = OpenTelemetry::Trace.current_span
        send_event(run_before_send(prepare(event), hint), span)
        event.event_id
      end

      def flush(timeout)
        @sink.flush(timeout)
      end

      def close(timeout)
        @sink.close(timeout)
      end

      private

      def drop_reason(event, hint)
        return "disabled" unless config.enabled?
        return "already captured" if Dedupe.captured?(hint[:exception])
        return "sampled out" if config.sample_rate < 1 && rand >= config.sample_rate
        return "excluded" if excluded?(hint[:exception])

        nil
      end

      def excluded?(error)
        return false unless error.is_a?(Exception)

        Array(config.excluded_exceptions).any? do |excluded|
          excluded.is_a?(Module) ? error.is_a?(excluded) : error.class.ancestors.any? { |ancestor| ancestor.name == excluded.to_s }
        end
      end

      def prepare(event)
        event.release ||= config.release
        event.environment ||= config.environment
        event
      end

      def run_before_send(event, hint)
        return event unless config.before_send

        result = config.before_send.call(event, hint)
        return result if result.is_a?(Event)

        log("before_send dropped an event")
        nil
      rescue StandardError => e
        log("before_send raised #{e.class}")
        nil
      end

      # Reporting must never raise into an app that is already handling an error.
      def send_event(event, span)
        return unless event
        return log("dropped a duplicate event") if @dedupe.duplicate?(event)
        return log("rate cap reached") unless @rate_cap.take

        record = Attributes.log_record(event)
        record_on_span(span, event, record)
        @sink.emit(record, span.context)
      rescue StandardError => e
        log("could not send an event: #{e.class}: #{e.message}")
      end

      # Built from the scrubbed record, so traces carry nothing the log doesn't.
      def record_on_span(span, event, record)
        return unless span.recording? && event.exception

        attributes = record.attributes.slice(*SPAN_EVENT_KEYS).transform_values(&:to_s)
        span.add_event("exception", attributes: attributes)
        return unless event.exception.handled == false

        span.status = OpenTelemetry::Trace::Status.error(attributes["exception.message"])
      end

      def log(message)
        warn("[instatus] #{message}") if config.debug
        nil
      end
    end
  end
end
