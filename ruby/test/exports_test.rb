# frozen_string_literal: true

require "test_helper"

class ExportsTest < Minitest::Test
  Exports = Instatus::Otel::Exports

  def test_api_key_sends_every_signal_to_the_collector
    exports = Exports.resolve(api_key: "sk_live", site_id: "site_1", env: {})
    assert_equal %i[logs traces metrics], exports.keys
    assert_equal "https://otel.instatus.com/v1/logs", exports[:logs].endpoint
    assert_equal "https://otel.instatus.com/v1/traces", exports[:traces].endpoint
    assert_equal "https://otel.instatus.com/v1/metrics", exports[:metrics].endpoint
    assert_equal({ "Authorization" => "Bearer sk_live", "X-Instatus-Site-Id" => "site_1" }, exports[:logs].headers)
  end

  def test_endpoint_replaces_the_host
    exports = Exports.resolve(api_key: "sk", endpoint: "http://localhost:4318/", env: {})
    assert_equal "http://localhost:4318/v1/traces", exports[:traces].endpoint
    assert_equal({ "Authorization" => "Bearer sk" }, exports[:traces].headers)
  end

  def test_env_endpoint_is_left_to_the_exporter
    exports = Exports.resolve(api_key: "sk", env: { "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT" => "http://c/v1/traces" })
    assert_nil exports[:traces].endpoint
    assert_equal({ endpoint: "https://otel.instatus.com/v1/logs", headers: { "Authorization" => "Bearer sk" } },
                 exports[:logs].exporter_options)
    assert_equal({ headers: { "Authorization" => "Bearer sk" } }, exports[:traces].exporter_options)
  end

  def test_endpoint_without_a_key
    exports = Exports.resolve(api_key: nil, endpoint: "http://collector:4318", env: {})
    assert_equal "http://collector:4318/v1/logs", exports[:logs].endpoint
    assert_empty exports[:logs].headers
  end

  def test_only_env_endpoints_without_key_or_endpoint
    assert_empty Exports.resolve(api_key: nil, env: {})
    exports = Exports.resolve(api_key: "", env: { "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT" => "http://c/v1/logs" })
    assert_equal [:logs], exports.keys
    assert_equal({}, exports[:logs].exporter_options)
    assert_equal %i[logs traces metrics], Exports.resolve(api_key: nil, env: { "OTEL_EXPORTER_OTLP_ENDPOINT" => "http://c" }).keys
  end

  def test_configuration_reads_the_environment
    config = Instatus::Configuration.new(
      "INSTATUS_API_KEY" => "sk_env", "INSTATUS_SITE_ID" => "site_env", "OTEL_SERVICE_NAME" => "billing"
    )
    assert_equal "sk_env", config.api_key
    assert_equal "site_env", config.site_id
    assert_equal "billing", config.service_name
    assert_equal 300, config.max_events_per_minute
  end

  def test_resource_attributes
    attributes = Instatus::Otel::Resource.attributes(service_name: "api", release: "abc123", environment: "production")
    assert_equal(
      {
        "service.name" => "api",
        "telemetry.sdk.name" => "instatus-otel",
        "telemetry.sdk.version" => Instatus::Otel::VERSION,
        "telemetry.sdk.language" => "ruby",
        "service.version" => "abc123",
        "deployment.environment.name" => "production"
      },
      attributes
    )
    assert_equal "ruby", Instatus::Otel::Resource.attributes["service.name"]
  end

  def test_resource_merges_detectors_and_otel_resource_attributes
    config = Instatus::Configuration.new({})
    config.enabled = false
    config.service_name = "api"
    previous = ENV["OTEL_RESOURCE_ATTRIBUTES"]
    ENV["OTEL_RESOURCE_ATTRIBUTES"] = "team=payments"
    OpenTelemetry::SDK::Resources::Resource.instance_variable_set(:@default, nil)
    attributes = Instatus::Otel::Providers.new(config).tracer_provider.resource.attribute_enumerator.to_h
    assert_equal "api", attributes["service.name"]
    assert_equal "instatus-otel", attributes["telemetry.sdk.name"]
    assert_equal "payments", attributes["team"]
    assert attributes.key?("process.pid")
    assert attributes.key?("host.name")
  ensure
    ENV["OTEL_RESOURCE_ATTRIBUTES"] = previous
    OpenTelemetry::SDK::Resources::Resource.instance_variable_set(:@default, nil)
  end
end
