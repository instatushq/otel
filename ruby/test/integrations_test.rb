# frozen_string_literal: true

require "test_helper"
require "stringio"

class IntegrationsTest < Minitest::Test
  include ClientHelpers

  def test_rack_middleware_reports_with_the_request_url_and_reraises
    client, sink = build_client
    app = ->(_env) { raise ArgumentError, "bad" }
    env = { "rack.url_scheme" => "https", "HTTP_HOST" => "shop.test", "PATH_INFO" => "/pay",
            "QUERY_STRING" => "token=abc&step=2", "REQUEST_METHOD" => "POST" }

    with_client(client) do
      assert_raises(ArgumentError) { Instatus::Otel::RackMiddleware.new(app).call(env) }
    end
    attributes = sink.records.first.first.attributes
    assert_equal "https://shop.test/pay?token=[Filtered]&step=2", attributes["url.full"]
    assert_equal "/pay", attributes["url.path"]
    assert_equal "POST", attributes["http.request.method"]
    assert_equal false, attributes["exception.handled"]
  end

  def test_rack_middleware_isolates_each_request
    client, sink = build_client
    app = lambda do |env|
      Instatus.set_user(id: env["user"]) if env["user"]
      Instatus.capture_message("seen", level: :error) if env["report"]
      [200, {}, []]
    end
    middleware = Instatus::Otel::RackMiddleware.new(app)

    with_client(client) do
      middleware.call({ "user" => "ada", "HTTP_HOST" => "a" })
      middleware.call({ "report" => true, "HTTP_HOST" => "a" })
    end
    refute sink.records.first.first.attributes.key?("enduser.id")
    assert_nil Instatus.current_scope.user
  end

  def test_rack_middleware_reports_errors_frameworks_rescued
    client, sink = build_client
    error = raised(KeyError, "missing")
    app = lambda do |env|
      env["sinatra.error"] = error
      [500, {}, []]
    end
    with_client(client) { Instatus::Otel::RackMiddleware.new(app).call({ "HTTP_HOST" => "a" }) }
    assert_equal "KeyError", sink.records.first.first.attributes["exception.type"]
  end

  def test_rails_error_subscriber
    client, sink = build_client
    with_client(client) do
      Instatus::Otel::RailsErrorSubscriber.new.report(
        raised, handled: true, severity: :warning, context: { job: "Mailer", controller: Object.new },
                source: "application.active_job"
      )
      Instatus::Otel::RailsErrorSubscriber.new.report(
        raised(KeyError), handled: true, severity: :error, context: {}, source: "redis_cache_store.active_support"
      )
    end
    assert_equal 1, sink.records.size
    record = sink.records.first.first
    assert_equal 13, record.severity_number
    assert_equal true, record.attributes["exception.handled"]
    assert_equal "Mailer", record.attributes["rails.job"]
    assert_equal "application.active_job", record.attributes["rails.source"]
    refute record.attributes.key?("rails.controller")
  end

  def test_logger_bridge_emits_records_and_writes_to_its_device
    exporter = OpenTelemetry::SDK::Logs::Export::InMemoryLogRecordExporter.new
    provider = OpenTelemetry::SDK::Logs::LoggerProvider.new
    provider.add_log_record_processor(OpenTelemetry::SDK::Logs::Export::SimpleLogRecordProcessor.new(exporter))
    device = StringIO.new
    logger = Instatus::Otel::Logger.new(device, progname: "billing", logger_provider: provider)
    logger.level = :info

    logger.debug("hidden")
    logger.info("paid with 4111 1111 1111 1111")
    logger.error(raised(RuntimeError, "boom"))
    logger.warn { "lazy" }

    records = exporter.emitted_log_records
    assert_equal ["paid with [Filtered]", "RuntimeError: boom", "lazy"], records.map(&:body)
    assert_equal [9, 17, 13], records.map(&:severity_number)
    assert_equal "RuntimeError", records[1].attributes["exception.type"]
    assert_equal "billing", records[0].attributes["log.logger"]
    assert_includes device.string, "lazy"
    refute_includes device.string, "hidden"
  end

  def test_instatus_logger_is_a_ruby_logger
    assert_kind_of ::Logger, Instatus.logger
    assert Instatus.logger.info("no device needed")
  end
end
