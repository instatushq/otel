# frozen_string_literal: true

module Instatus
  class Configuration
    DEFAULT_MAX_EVENTS_PER_MINUTE = 300
    DEFAULT_SHUTDOWN_TIMEOUT = 2

    attr_accessor :api_key, :site_id, :endpoint, :service_name, :release, :environment,
                  :traces_sample_rate, :sample_rate, :before_send, :max_events_per_minute,
                  :enabled, :debug, :instrumentations, :metrics_export_interval,
                  :shutdown_timeout, :excluded_exceptions

    def initialize(env = ENV)
      @api_key = env["INSTATUS_API_KEY"]
      @site_id = env["INSTATUS_SITE_ID"]
      @service_name = env["OTEL_SERVICE_NAME"]
      @traces_sample_rate = 1.0
      @sample_rate = 1.0
      @max_events_per_minute = DEFAULT_MAX_EVENTS_PER_MINUTE
      @enabled = true
      @debug = false
      @instrumentations = nil
      @metrics_export_interval = 60
      @shutdown_timeout = DEFAULT_SHUTDOWN_TIMEOUT
      @excluded_exceptions = []
    end

    def enabled?
      @enabled != false
    end
  end
end
