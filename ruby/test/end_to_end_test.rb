# frozen_string_literal: true

require "test_helper"
require "open3"
require "support/collector"

class EndToEndTest < Minitest::Test
  RUBY_FRAME = /\A\s*(?:from )?(.+?):(\d+):in [`'](.*)'\s*\z/
  LIB = File.expand_path("../lib", __dir__)

  def setup
    @collector = Collector.new
  end

  def teardown
    Instatus.close(5)
    @collector.stop
  end

  def attributes_of(record)
    Collector.attribute_map(record.attributes)
  end

  def checkout
    raise ArgumentError, "card 4111 1111 1111 1111 declined"
  end

  def run_script(mode)
    script = <<~RUBY
      require "instatus/otel"
      Instatus.init(api_key: "sk_test", site_id: "site_1", endpoint: ARGV[0])
      def explode = raise(IOError, "disk gone")
      ARGV[1] == "exit" ? exit(3) : explode
    RUBY
    Open3.capture3(RbConfig.ruby, "-I", LIB, "-e", script, @collector.endpoint, mode)
  end

  def test_errors_logs_and_traces_reach_the_collector
    Instatus.init do |config|
      config.api_key = "sk_test"
      config.site_id = "site_1"
      config.endpoint = @collector.endpoint
      config.service_name = "shop"
      config.release = "1.0.0"
    end

    event_id = nil
    span_id = nil
    Instatus.start_span("checkout") do |span|
      span_id = span.context.hex_span_id
      Instatus.set_user(id: "user_1")
      begin
        checkout
      rescue ArgumentError => e
        event_id = Instatus.capture_exception(e, tags: { step: "charge" })
      end
      Instatus.logger.info("charge retried")
    end
    assert Instatus.flush(5)
    requests = @collector.requests

    assert_includes requests.map(&:path), "/v1/logs"
    assert_includes requests.map(&:path), "/v1/traces"
    requests.each do |request|
      assert_equal "Bearer sk_test", request.headers["authorization"], request.path
      assert_equal "site_1", request.headers["x-instatus-site-id"], request.path
      assert_equal "application/x-protobuf", request.headers["content-type"], request.path
    end

    logs_request = requests.find { |request| request.path == "/v1/logs" }
    export = Opentelemetry::Proto::Collector::Logs::V1::ExportLogsServiceRequest.decode(logs_request.body)
    resource = Collector.attribute_map(export.resource_logs.first.resource.attributes)
    assert_equal "shop", resource["service.name"]
    assert_equal "instatus-otel", resource["telemetry.sdk.name"]
    assert_equal "ruby", resource["telemetry.sdk.language"]
    assert_equal "1.0.0", resource["service.version"]

    logs = Collector.log_records(requests)
    error = logs.find { |record| attributes_of(record)["log.record.uid"] == event_id }
    refute_nil error
    attributes = attributes_of(error)
    assert_equal "ArgumentError: card [Filtered] declined", error.body.string_value
    assert_equal :SEVERITY_NUMBER_ERROR, error.severity_number
    assert_equal "ERROR", error.severity_text
    assert_equal "ArgumentError", attributes["exception.type"]
    assert_equal "card [Filtered] declined", attributes["exception.message"]
    assert_equal true, attributes["exception.handled"]
    assert_equal "charge", attributes["step"]
    assert_equal "user_1", attributes["enduser.id"]
    assert_equal span_id, error.span_id.unpack1("H*")

    frames = attributes["exception.stacktrace"].lines.map(&:chomp)
    assert frames.all? { |line| RUBY_FRAME.match?(line) }, frames.first(3).inspect
    assert_match(/end_to_end_test\.rb:\d+:in [`'].*checkout'/, frames.first)

    info = logs.find { |record| record.body.string_value == "charge retried" }
    refute_nil info
    assert_equal span_id, info.span_id.unpack1("H*")

    spans = requests.select { |request| request.path == "/v1/traces" }.flat_map do |request|
      Opentelemetry::Proto::Collector::Trace::V1::ExportTraceServiceRequest.decode(request.body)
                                                                            .resource_spans.flat_map(&:scope_spans)
                                                                            .flat_map(&:spans)
    end
    span = spans.find { |candidate| candidate.name == "checkout" }
    refute_nil span
    exception = span.events.find { |event| event.name == "exception" }
    assert_equal "ArgumentError", Collector.attribute_map(exception.attributes)["exception.type"]
    assert_equal "user_1", Collector.attribute_map(span.attributes)["enduser.id"]
  end

  def test_an_uncaught_exception_is_reported_as_fatal_before_ruby_exits
    _stdout, stderr, status = run_script("raise")

    assert_equal 1, status.exitstatus
    assert_includes stderr, "disk gone (IOError)"
    record = Collector.log_records(@collector.requests).first
    refute_nil record
    attributes = attributes_of(record)
    assert_equal :SEVERITY_NUMBER_FATAL, record.severity_number
    assert_equal "IOError", attributes["exception.type"]
    assert_equal false, attributes["exception.handled"]
    assert_match(/-e:\d+:in [`'].*explode'/, attributes["exception.stacktrace"].lines.first)
  end

  def test_exit_is_not_reported
    _stdout, _stderr, status = run_script("exit")

    assert_equal 3, status.exitstatus
    assert_empty Collector.log_records(@collector.requests)
  end
end
