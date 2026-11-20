# frozen_string_literal: true

require_relative "otel/version"
require_relative "otel/scrub"
require_relative "otel/event"
require_relative "otel/scope"
require_relative "otel/attributes"
require_relative "otel/dedupe"
require_relative "otel/rate_cap"
require_relative "otel/configuration"
require_relative "otel/exports"
require_relative "otel/resource"
require_relative "otel/providers"
require_relative "otel/client"
require_relative "otel/logger"
require_relative "otel/rack"
require_relative "otel/rails_error_subscriber"

module Instatus
  SCOPE_KEY = OpenTelemetry::Context.create_key("instatus-scope")
  THREAD_SCOPE = :__instatus_scope
  UNCAUGHT_EXCLUDED = [SystemExit, SignalException].freeze

  @mutex = Mutex.new
  @global_scope = Scope.new
  @client = nil
  @last_event_id = nil

  class << self
    attr_reader :client, :global_scope, :last_event_id

    def init(**options)
      config = Configuration.new
      options.each { |key, value| config.public_send(:"#{key}=", value) }
      yield config if block_given?

      @mutex.synchronize do
        return @client if @client

        providers = Otel::Providers.new(config).install
        @client = Otel::Client.new(config, sink: providers)
        install_at_exit
        @client
      end
    end

    def initialized?
      !@client.nil?
    end

    # with_scope keeps its copy in the OpenTelemetry context, which is per fiber.
    def current_scope
      OpenTelemetry::Context.current.value(SCOPE_KEY) || thread_scope
    end

    def with_scope
      scope = current_scope.dup
      OpenTelemetry::Context.with_value(SCOPE_KEY, scope) { yield scope }
    end

    def capture_exception(error, **context, &block)
      capture_with_mechanism(error, handled: true, mechanism: "generic", **context, &block)
    end

    def capture_with_mechanism(error, handled:, mechanism:, **context, &block)
      event = Event.from_exception(error, handled: handled, mechanism: mechanism)
      capture(event, { exception: error }, scope_for(context, &block))
    end

    def capture_message(message, level: :info, **context, &block)
      event = Event.from_message(message, level)
      capture(event, {}, scope_for(context, &block))
    end

    def set_user(user)
      current_scope.set_user(user)
      span = OpenTelemetry::Trace.current_span
      return unless user && span.recording?

      user = user.to_h.transform_keys(&:to_s)
      id = user["id"] || user["email"] || user["username"]
      span.set_attribute("enduser.id", id.to_s) unless id.nil?
    end

    def set_tag(key, value)
      current_scope.set_tag(key, value)
    end

    def set_tags(tags)
      current_scope.set_tags(tags)
    end

    def set_context(name, context)
      current_scope.set_context(name, context)
    end

    def set_extra(key, value)
      current_scope.set_extra(key, value)
    end

    def set_extras(extras)
      current_scope.set_extras(extras)
    end

    def start_span(name, attributes: nil, op: nil, kind: :internal)
      attributes = (attributes || {}).merge("sentry.op" => op.to_s) if op
      span = tracer.start_span(name.to_s, attributes: attributes, kind: kind)
      OpenTelemetry::Trace.with_span(span) { yield span }
    rescue Exception => e
      span&.status = OpenTelemetry::Trace::Status.error(Otel::Scrub.scrub_text(e.message))
      raise
    ensure
      span&.finish
    end

    def active_span
      OpenTelemetry::Trace.current_span
    end

    def flush(timeout = Configuration::DEFAULT_SHUTDOWN_TIMEOUT)
      return true unless @client

      @client.flush(timeout)
    end

    def close(timeout = Configuration::DEFAULT_SHUTDOWN_TIMEOUT)
      client = @mutex.synchronize { @client.tap { @client = nil } }
      return true unless client

      client.close(timeout)
    end

    def logger
      @logger ||= Otel::Logger.new
    end

    def tracer
      OpenTelemetry.tracer_provider.tracer(Otel::SDK_NAME, Otel::VERSION)
    end

    private

    def thread_scope
      return @global_scope if Thread.current == Thread.main

      Thread.current[THREAD_SCOPE] ||= @global_scope.dup
    end

    def scope_for(context)
      return current_scope if context.empty? && !block_given?

      scope = current_scope.dup.update(**context)
      yield scope if block_given?
      scope
    end

    def capture(event, hint, scope)
      scope.apply(event)
      return event.event_id unless @client

      @last_event_id = @client.capture_event(event, hint)
    end

    def install_at_exit
      return if @at_exit_installed

      @at_exit_installed = true
      at_exit { report_exit($!) }
    end

    # Ruby prints the error and exits after at_exit handlers, so its behaviour is unchanged.
    def report_exit(error)
      timeout = @client&.config&.shutdown_timeout || Configuration::DEFAULT_SHUTDOWN_TIMEOUT
      if error && UNCAUGHT_EXCLUDED.none? { |type| error.is_a?(type) }
        capture_with_mechanism(error, handled: false, mechanism: "at_exit", level: :fatal)
      end
      close(timeout)
    rescue StandardError
      nil
    end
  end
end

require_relative "otel/rails" if defined?(::Rails::Railtie)
