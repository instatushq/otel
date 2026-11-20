# frozen_string_literal: true

require "json"
require "uri"

module Instatus
  module Otel
    LogRecord = Struct.new(:timestamp, :severity_number, :severity_text, :body, :attributes, keyword_init: true)

    module Attributes
      Severity = Struct.new(:number, :text)

      SEVERITY = {
        fatal: Severity.new(21, "FATAL"),
        error: Severity.new(17, "ERROR"),
        warning: Severity.new(13, "WARN"),
        warn: Severity.new(13, "WARN"),
        log: Severity.new(9, "INFO"),
        info: Severity.new(9, "INFO"),
        debug: Severity.new(5, "DEBUG")
      }.freeze

      RESERVED_PREFIX = "instatus."
      MAX_VALUE_LENGTH = 8192
      MAX_STACK_LENGTH = 32_000
      DEFAULT_EXCEPTION_TYPE = "Error"
      USER_KEYS = { "username" => "name", "ip_address" => "ip" }.freeze

      module_function

      def severity_of(level)
        SEVERITY.fetch(level.to_s.to_sym, SEVERITY[:error])
      end

      def error?(level)
        severity_of(level).number >= SEVERITY[:error].number
      end

      def to_attribute_value(value)
        case value
        when nil then nil
        when String then value[0, MAX_VALUE_LENGTH]
        when Integer, Float, true, false then value
        when Symbol, Numeric then value.to_s
        else stringify(value)[0, MAX_VALUE_LENGTH]
        end
      end

      def stringify(value)
        JSON.generate(value)
      rescue StandardError
        value.to_s
      end

      def put(attributes, key, value)
        return if key.start_with?(RESERVED_PREFIX)

        attribute = to_attribute_value(Scrub.scrub_value(key, value))
        attributes[key] = attribute unless attribute.nil? || attribute == ""
      end

      def user_attributes(user)
        attributes = {}
        return attributes unless user

        user = user.transform_keys(&:to_s)
        end_user = user["id"] || user["email"] || user["username"]
        attributes["enduser.id"] = end_user.to_s unless end_user.nil? || end_user.to_s.empty?
        user.each { |key, value| put(attributes, "user.#{USER_KEYS.fetch(key, key)}", value) }
        attributes
      end

      def metadata_of(event)
        metadata = {}
        event.tags.each { |key, value| put(metadata, key.to_s, value) }
        event.contexts.each do |name, context|
          if context.is_a?(Hash)
            context.each { |key, value| put(metadata, "#{name}.#{key}", value) }
          else
            put(metadata, name.to_s, context)
          end
        end
        event.extra.each { |key, value| put(metadata, "extra.#{key}", value) }
        metadata.merge(user_attributes(event.user))
      end

      def exception_attributes(event)
        exception = event.exception
        if exception
          attributes = {
            "exception.type" => exception.type.to_s.empty? ? DEFAULT_EXCEPTION_TYPE : exception.type.to_s,
            "exception.message" => Scrub.scrub_text(exception.value)[0, MAX_VALUE_LENGTH]
          }
          if exception.stacktrace
            attributes["exception.stacktrace"] = Scrub.scrub_text(exception.stacktrace)[0, MAX_STACK_LENGTH]
          end
          attributes["exception.handled"] = exception.handled unless exception.handled.nil?
          return attributes
        end
        return {} unless error?(event.level) && event.message

        {
          "exception.type" => DEFAULT_EXCEPTION_TYPE,
          "exception.message" => Scrub.scrub_text(event.message)[0, MAX_VALUE_LENGTH]
        }
      end

      def request_attributes(request)
        return {} unless request&.dig(:url)

        url = Scrub.scrub_url(request[:url])
        attributes = { "url.full" => url[0, MAX_VALUE_LENGTH] }
        path = path_of(url)
        attributes["url.path"] = path if path && !path.empty?
        attributes["http.request.method"] = request[:method].to_s if request[:method]
        attributes
      end

      def path_of(url)
        URI.parse(url).path
      rescue URI::Error
        nil
      end

      def headline(type, message)
        message.empty? ? type : "#{type}: #{message}"
      end

      def body_of(event)
        exception = event.exception
        return Scrub.scrub_text(event.message.to_s) unless exception

        type = exception.type.to_s.empty? ? DEFAULT_EXCEPTION_TYPE : exception.type.to_s
        headline(type, Scrub.scrub_text(exception.value))
      end

      # Error fields go first and win: receivers cap attribute counts.
      def log_record(event)
        severity = severity_of(event.level)
        attributes = exception_attributes(event)
        attributes["log.record.uid"] = event.event_id
        attributes.merge!(request_attributes(event.request))
        metadata_of(event).each { |key, value| attributes[key] = value unless attributes.key?(key) }

        LogRecord.new(
          timestamp: event.timestamp,
          severity_number: severity.number,
          severity_text: severity.text,
          body: body_of(event),
          attributes: attributes
        )
      end
    end
  end
end
