# frozen_string_literal: true

module Instatus
  module Otel
    # Its own scope per request, so set_user never reaches the next request on the thread.
    class RackMiddleware
      def initialize(app)
        @app = app
      end

      def call(env)
        Instatus.with_scope do |scope|
          scope.set_request(url: request_url(env), method: env["REQUEST_METHOD"])
          response = call_app(env)
          error = env["rack.exception"] || env["sinatra.error"]
          report(error) if error
          response
        end
      end

      private

      def call_app(env)
        @app.call(env)
      rescue Exception => e
        report(e) unless e.is_a?(SystemExit) || e.is_a?(SignalException)
        raise
      end

      def report(error)
        Instatus.capture_with_mechanism(error, handled: false, mechanism: "rack")
      end

      def request_url(env)
        scheme = env["rack.url_scheme"] || "http"
        host = env["HTTP_HOST"] || [env["SERVER_NAME"], env["SERVER_PORT"]].compact.join(":")
        path = "#{env["SCRIPT_NAME"]}#{env["PATH_INFO"]}"
        query = env["QUERY_STRING"].to_s
        query.empty? ? "#{scheme}://#{host}#{path}" : "#{scheme}://#{host}#{path}?#{query}"
      end
    end
  end
end
