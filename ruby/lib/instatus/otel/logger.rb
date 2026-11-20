# frozen_string_literal: true

require "logger"

module Instatus
  module Otel
    class Logger < ::Logger
      SEVERITY = {
        ::Logger::DEBUG => [5, "DEBUG"],
        ::Logger::INFO => [9, "INFO"],
        ::Logger::WARN => [13, "WARN"],
        ::Logger::ERROR => [17, "ERROR"],
        ::Logger::FATAL => [21, "FATAL"],
        ::Logger::UNKNOWN => [0, "UNKNOWN"]
      }.freeze

      def initialize(logdev = nil, *args, logger_provider: nil, **options)
        super(logdev, *args, **options)
        @logger_provider = logger_provider
      end

      def add(severity, message = nil, progname = nil)
        severity ||= ::Logger::UNKNOWN
        return true if severity < level

        if message.nil?
          if block_given?
            message = yield
          else
            message = progname
            progname = self.progname
          end
        end
        emit(severity, message, progname)
        super(severity, message, progname)
      end

      private

      def emit(severity, message, progname)
        number, text = SEVERITY.fetch(severity, SEVERITY[::Logger::UNKNOWN])
        attributes = message.is_a?(Exception) ? exception_attributes(message) : {}
        attributes["log.logger"] = progname.to_s if progname
        otel_logger.on_emit(
          timestamp: Time.now,
          observed_timestamp: Time.now,
          severity_number: number,
          severity_text: text,
          body: body_of(message),
          attributes: attributes,
          context: OpenTelemetry::Context.current
        )
      rescue StandardError
        nil
      end

      def otel_logger
        (@logger_provider || OpenTelemetry.logger_provider).logger(name: SDK_NAME, version: VERSION)
      end

      def body_of(message)
        text =
          case message
          when String then message
          when Exception then Attributes.headline(message.class.name.to_s, message.message.to_s)
          else message.inspect
          end
        Scrub.scrub_text(text)[0, Attributes::MAX_VALUE_LENGTH]
      end

      def exception_attributes(error)
        value = Event.exception_value(error, handled: nil, mechanism: nil)
        Attributes.exception_attributes(Event.build(level: :error, exception: value))
      end
    end
  end
end
