# frozen_string_literal: true

module Instatus
  module Otel
    class Railtie < ::Rails::Railtie
      initializer "instatus.rack_middleware" do |app|
        app.config.middleware.insert(0, RackMiddleware)
      end

      config.after_initialize do
        ::Rails.error.subscribe(RailsErrorSubscriber.new) if ::Rails.respond_to?(:error)
      end
    end
  end
end
