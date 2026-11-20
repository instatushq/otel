# frozen_string_literal: true

require "test_helper"

class ClientTest < Minitest::Test
  include ClientHelpers

  def event_for(error)
    Instatus::Event.from_exception(error, handled: true, mechanism: "generic")
  end

  def test_identical_errors_in_a_row_are_sent_once
    client, sink = build_client
    error = raised
    2.times { client.capture_event(event_for(error)) }
    assert_equal 1, sink.records.size

    client.capture_event(Instatus::Event.from_message("other", :error))
    client.capture_event(event_for(error))
    assert_equal 3, sink.records.size
  end

  def test_the_same_exception_object_is_captured_once
    client, sink = build_client
    error = raised
    client.capture_event(event_for(error), { exception: error })
    client.capture_event(Instatus::Event.from_message("between", :info))
    client.capture_event(event_for(error), { exception: error })
    assert_equal 2, sink.records.size
  end

  def test_rate_cap
    client, sink = build_client(max_events_per_minute: 3)
    5.times { |index| client.capture_event(Instatus::Event.from_message("m#{index}", :error)) }
    assert_equal 3, sink.records.size
  end

  def test_rate_cap_window_resets
    now = 0
    cap = Instatus::Otel::RateCap.new(2, 60, clock: -> { now })
    assert cap.take
    assert cap.take
    refute cap.take
    now = 60
    assert cap.take
  end

  def test_before_send_can_change_or_drop
    seen = []
    client, sink = build_client(before_send: lambda { |event, hint|
      seen << hint[:exception]
      next nil if event.exception.value == "drop me"

      event.tags["checked"] = "yes"
      event
    })
    error = raised(RuntimeError, "keep me")
    client.capture_event(event_for(error), { exception: error })
    client.capture_event(event_for(raised(RuntimeError, "drop me")))

    assert_same error, seen.first
    assert_equal 1, sink.records.size
    assert_equal "yes", sink.records.first.first.attributes["checked"]
  end

  def test_before_send_runs_before_filters
    client, sink = build_client(before_send: lambda { |event, _hint|
      event.extra["card"] = "4111 1111 1111 1111"
      event
    })
    client.capture_event(event_for(raised))
    assert_equal "[Filtered]", sink.records.first.first.attributes["extra.card"]
  end

  def test_before_send_that_raises_drops_the_event
    client, sink = build_client(before_send: ->(_event, _hint) { raise "oops" })
    client.capture_event(event_for(raised))
    assert_empty sink.records
  end

  def test_disabled_and_excluded
    client, sink = build_client(enabled: false)
    client.capture_event(event_for(raised))
    assert_empty sink.records

    client, sink = build_client(excluded_exceptions: [ArgumentError, "KeyError"])
    [raised(ArgumentError), raised(KeyError)].each { |error| client.capture_event(event_for(error), { exception: error }) }
    assert_empty sink.records
  end

  def test_release_and_environment
    client, sink = build_client(release: "1.2.3", environment: "staging", before_send: lambda { |event, _hint|
      event.tags["release"] = event.release
      event
    })
    client.capture_event(event_for(raised))
    assert_equal "1.2.3", sink.records.first.first.attributes["release"]
  end

  def test_errors_go_on_the_active_span
    exporter = OpenTelemetry::SDK::Trace::Export::InMemorySpanExporter.new
    provider = OpenTelemetry::SDK::Trace::TracerProvider.new
    provider.add_span_processor(OpenTelemetry::SDK::Trace::Export::SimpleSpanProcessor.new(exporter))
    client, sink = build_client
    span = provider.tracer("test").start_span("checkout")
    OpenTelemetry::Trace.with_span(span) do
      client.capture_event(Instatus::Event.from_exception(raised(RuntimeError, "card 4111111111111111"),
                                                          handled: false, mechanism: "rack"))
    end
    span.finish

    finished = exporter.finished_spans.first
    event = finished.events.first
    assert_equal "exception", event.name
    assert_equal "RuntimeError", event.attributes["exception.type"]
    assert_equal "card [Filtered]", event.attributes["exception.message"]
    assert_equal OpenTelemetry::Trace::Status::ERROR, finished.status.code
    assert_equal span.context.span_id, sink.records.first.last.span_id
  end

  def test_start_span_filters_the_error_it_fails_with
    exporter = OpenTelemetry::SDK::Trace::Export::InMemorySpanExporter.new
    provider = OpenTelemetry::SDK::Trace::TracerProvider.new
    provider.add_span_processor(OpenTelemetry::SDK::Trace::Export::SimpleSpanProcessor.new(exporter))
    previous = OpenTelemetry.tracer_provider
    OpenTelemetry.tracer_provider = provider
    client, = build_client

    with_client(client) do
      assert_raises(RuntimeError) do
        Instatus.start_span("checkout") do
          error = raised(RuntimeError, "card 4111 1111 1111 1111 declined")
          Instatus.capture_exception(error)
          raise error
        end
      end
    end

    finished = exporter.finished_spans.first
    assert_equal OpenTelemetry::Trace::Status::ERROR, finished.status.code
    assert_equal "card [Filtered] declined", finished.status.description
    assert_equal ["card [Filtered] declined"], finished.events.map { |event| event.attributes["exception.message"] }
    refute_match(/4111/, finished.events.flat_map { |event| event.attributes.values }.join)
  ensure
    OpenTelemetry.tracer_provider = previous
  end
end
