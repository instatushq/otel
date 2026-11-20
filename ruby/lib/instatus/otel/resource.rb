# frozen_string_literal: true

require "etc"
require "socket"

module Instatus
  module Otel
    module Resource
      LANGUAGE = "ruby"
      FALLBACK_SERVICE_NAME = "ruby"

      module_function

      def attributes(service_name: nil, release: nil, environment: nil)
        attributes = {
          "service.name" => present(service_name) || FALLBACK_SERVICE_NAME,
          "telemetry.sdk.name" => SDK_NAME,
          "telemetry.sdk.version" => VERSION,
          "telemetry.sdk.language" => LANGUAGE
        }
        attributes["service.version"] = release.to_s if present(release)
        attributes["deployment.environment.name"] = environment.to_s if present(environment)
        attributes
      end

      def host_attributes
        attributes = { "host.arch" => RbConfig::CONFIG["host_cpu"], "os.type" => os_type }
        hostname = Socket.gethostname
        attributes["host.name"] = hostname if hostname && !hostname.empty?
        attributes.compact
      rescue SystemCallError, SocketError
        attributes.compact
      end

      def os_type
        case RbConfig::CONFIG["host_os"]
        when /darwin/ then "darwin"
        when /linux/ then "linux"
        when /mswin|mingw|cygwin/ then "windows"
        when /freebsd/ then "freebsd"
        else RbConfig::CONFIG["host_os"]
        end
      end

      def present(value)
        value.nil? || value.to_s.empty? ? nil : value.to_s
      end
    end
  end
end
