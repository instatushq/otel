# frozen_string_literal: true

module Instatus
  module Otel
    # endpoint nil leaves the OTLP exporter to read OTEL_EXPORTER_OTLP_* itself.
    SignalExport = Struct.new(:endpoint, :headers, keyword_init: true) do
      def exporter_options
        options = {}
        options[:endpoint] = endpoint if endpoint
        options[:headers] = headers unless headers.empty?
        options
      end
    end

    module Exports
      DEFAULT_ENDPOINT = "https://otel.instatus.com"
      SIGNALS = %i[logs traces metrics].freeze

      module_function

      # Without an API key or endpoint only OTEL_EXPORTER_OTLP_* exports: servers have no DSN mode.
      def resolve(api_key:, site_id: nil, endpoint: nil, env: ENV)
        if present?(api_key)
          headers = { "Authorization" => "Bearer #{api_key}" }
          headers["X-Instatus-Site-Id"] = site_id.to_s if present?(site_id)
          return every_signal { |signal| SignalExport.new(endpoint: url_for(endpoint, env, signal), headers: headers) }
        end
        if present?(endpoint)
          return every_signal { |signal| SignalExport.new(endpoint: signal_url(endpoint, signal), headers: {}) }
        end

        SIGNALS.select { |signal| env_endpoint?(env, signal) }.to_h { |signal| [signal, SignalExport.new(headers: {})] }
      end

      def every_signal(&build)
        SIGNALS.to_h { |signal| [signal, build.call(signal)] }
      end

      def url_for(endpoint, env, signal)
        return signal_url(endpoint, signal) if present?(endpoint)
        return nil if env_endpoint?(env, signal)

        signal_url(DEFAULT_ENDPOINT, signal)
      end

      def signal_url(endpoint, signal)
        "#{endpoint.to_s.sub(%r{/+\z}, "")}/v1/#{signal}"
      end

      def env_endpoint?(env, signal)
        present?(env["OTEL_EXPORTER_OTLP_#{signal.to_s.upcase}_ENDPOINT"]) || present?(env["OTEL_EXPORTER_OTLP_ENDPOINT"])
      end

      def present?(value)
        !value.nil? && !value.to_s.empty?
      end
    end
  end
end
