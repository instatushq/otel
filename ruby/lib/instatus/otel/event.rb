# frozen_string_literal: true

require "securerandom"

module Instatus
  ExceptionValue = Struct.new(:type, :value, :stacktrace, :handled, :mechanism, keyword_init: true)

  Event = Struct.new(
    :event_id, :timestamp, :level, :message, :exception, :user, :tags, :extra, :contexts, :request,
    :release, :environment,
    keyword_init: true
  ) do
    def self.build(level:, message: nil, exception: nil)
      new(
        event_id: SecureRandom.hex(16),
        timestamp: Time.now,
        level: level.to_sym,
        message: message,
        exception: exception,
        tags: {},
        extra: {},
        contexts: {}
      )
    end

    def self.from_exception(error, handled:, mechanism:)
      build(level: :error, exception: exception_value(error, handled: handled, mechanism: mechanism))
    end

    def self.from_message(message, level)
      build(level: level, message: message.to_s)
    end

    # Not full_message: its first line carries the message, which the stack parser can't read as a frame.
    def self.exception_value(error, handled:, mechanism:)
      unless error.is_a?(Exception)
        type = error.is_a?(String) ? "RuntimeError" : error.class.name
        value = error.is_a?(String) ? error : error.inspect
        return ExceptionValue.new(type: type, value: value, handled: handled, mechanism: mechanism)
      end

      ExceptionValue.new(
        type: error.class.name || error.class.inspect,
        value: error.message.to_s,
        stacktrace: error.backtrace&.join("\n"),
        handled: handled,
        mechanism: mechanism
      )
    end
  end
end
