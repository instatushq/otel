# frozen_string_literal: true

module Instatus
  module Otel
    # As Sentry's Dedupe: a repeat of the last event is a re-raise or a second reporter.
    class Dedupe
      MARKER = :@__instatus_captured

      def self.captured?(error)
        error.is_a?(Exception) && error.instance_variable_defined?(MARKER)
      end

      def self.mark_captured(error)
        error.instance_variable_set(MARKER, true) if error.is_a?(Exception) && !error.frozen?
      end

      def initialize
        @previous = nil
        @mutex = Mutex.new
      end

      def duplicate?(event)
        signature = signature_of(event)
        @mutex.synchronize do
          duplicate = signature == @previous
          @previous = signature
          duplicate
        end
      end

      private

      def signature_of(event)
        exception = event.exception
        return "message|#{event.message}" unless exception

        "#{exception.type}|#{exception.value}|#{exception.stacktrace}"
      end
    end
  end
end
