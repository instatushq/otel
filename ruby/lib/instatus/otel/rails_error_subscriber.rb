# frozen_string_literal: true

module Instatus
  module Otel
    class RailsErrorSubscriber
      SKIP_SOURCES = /_cache_store\.active_support\z/
      CONTEXT_VALUES = [String, Symbol, Numeric, TrueClass, FalseClass, Hash, Array].freeze

      def report(error, handled:, severity:, context:, source: nil)
        return if source && SKIP_SOURCES.match?(source)

        tags = source ? { "rails.source" => source } : {}
        rails_context = context.select { |_key, value| CONTEXT_VALUES.any? { |type| value.is_a?(type) } }
        contexts = rails_context.empty? ? {} : { "rails" => rails_context }
        Instatus.capture_with_mechanism(
          error, handled: handled, mechanism: "rails", level: severity, tags: tags, contexts: contexts
        )
      end
    end
  end
end
