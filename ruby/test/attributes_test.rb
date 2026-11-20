# frozen_string_literal: true

require "test_helper"

class AttributesTest < Minitest::Test
  include ClientHelpers

  Attributes = Instatus::Otel::Attributes

  def exception_event(error = raised(ArgumentError, "bad input"), handled: true)
    Instatus::Event.from_exception(error, handled: handled, mechanism: "generic")
  end

  def test_exception_record
    error = raised(ArgumentError, "bad input")
    record = Attributes.log_record(exception_event(error))

    assert_equal "ArgumentError: bad input", record.body
    assert_equal 17, record.severity_number
    assert_equal "ERROR", record.severity_text
    assert_equal "ArgumentError", record.attributes["exception.type"]
    assert_equal "bad input", record.attributes["exception.message"]
    assert_equal error.backtrace.join("\n"), record.attributes["exception.stacktrace"]
    assert_equal true, record.attributes["exception.handled"]
    assert_match(/\A\h{32}\z/, record.attributes["log.record.uid"])
  end

  def test_stacktrace_is_ruby_backtrace_text
    stack = Attributes.log_record(exception_event).attributes["exception.stacktrace"]
    first = stack.lines.first.chomp
    assert_match(/\A.+\.rb:\d+:in [`'].*'\z/, first)
    assert_match(/:\d+:in [`']/, stack)
  end

  def test_namespaced_class_name
    error_class = Class.new(StandardError)
    AttributesTest.const_set(:PaymentDeclined, error_class) unless AttributesTest.const_defined?(:PaymentDeclined)
    record = Attributes.log_record(exception_event(raised(AttributesTest::PaymentDeclined, "no")))
    assert_equal "AttributesTest::PaymentDeclined", record.attributes["exception.type"]
  end

  def test_severity_levels
    expected = { fatal: [21, "FATAL"], error: [17, "ERROR"], warning: [13, "WARN"], info: [9, "INFO"],
                 log: [9, "INFO"], debug: [5, "DEBUG"] }
    expected.each do |level, (number, text)|
      record = Attributes.log_record(Instatus::Event.from_message("hi", level))
      assert_equal [number, text], [record.severity_number, record.severity_text], level
    end
  end

  def test_error_messages_are_issues_and_info_messages_are_logs
    error = Attributes.log_record(Instatus::Event.from_message("Webhook failed", :error))
    assert_equal "Error", error.attributes["exception.type"]
    assert_equal "Webhook failed", error.attributes["exception.message"]

    info = Attributes.log_record(Instatus::Event.from_message("Signed in", :info))
    assert_equal "Signed in", info.body
    refute info.attributes.key?("exception.type")
  end

  def test_scope_metadata
    event = exception_event
    scope = Instatus::Scope.new
    scope.set_user(id: 42, email: "a@example.com", username: "ada", ip_address: "1.2.3.4")
    scope.set_tags(plan: "pro", "instatus.internal" => "x")
    scope.set_context("cart", { items: 3, password: "p" })
    scope.set_extra("retry", 2)
    scope.set_extra("payload", { nested: [1, 2] })
    attributes = Attributes.log_record(scope.apply(event)).attributes

    assert_equal "42", attributes["enduser.id"]
    assert_equal 42, attributes["user.id"]
    assert_equal "a@example.com", attributes["user.email"]
    assert_equal "ada", attributes["user.name"]
    assert_equal "1.2.3.4", attributes["user.ip"]
    assert_equal "pro", attributes["plan"]
    refute attributes.key?("instatus.internal")
    assert_equal 3, attributes["cart.items"]
    assert_equal "[Filtered]", attributes["cart.password"]
    assert_equal 2, attributes["extra.retry"]
    assert_equal '{"nested":[1,2]}', attributes["extra.payload"]
  end

  def test_end_user_falls_back_to_email_then_username
    event = Instatus::Event.from_message("x", :info)
    event.user = { "email" => "a@example.com" }
    assert_equal "a@example.com", Attributes.log_record(event).attributes["enduser.id"]
    event.user = { username: "ada" }
    assert_equal "ada", Attributes.log_record(event).attributes["enduser.id"]
  end

  def test_error_fields_win_over_metadata
    event = exception_event
    event.tags = { "exception.type" => "Spoofed", "log.record.uid" => "x" }
    attributes = Attributes.log_record(event).attributes
    assert_equal "ArgumentError", attributes["exception.type"]
    assert_equal event.event_id, attributes["log.record.uid"]
  end

  def test_long_values_are_cut
    event = exception_event(raised(RuntimeError, "x" * 10_000))
    event.extra = { "blob" => "y" * 10_000 }
    event.exception.stacktrace = "app.rb:1:in 'a'\n" * 3000
    attributes = Attributes.log_record(event).attributes
    assert_equal 8192, attributes["exception.message"].length
    assert_equal 8192, attributes["extra.blob"].length
    assert_equal 32_000, attributes["exception.stacktrace"].length
  end

  def test_card_numbers_leave_messages_and_stacks
    event = exception_event(raised(RuntimeError, "charge 4111 1111 1111 1111 failed"))
    record = Attributes.log_record(event)
    assert_equal "RuntimeError: charge [Filtered] failed", record.body
    assert_equal "charge [Filtered] failed", record.attributes["exception.message"]
  end

  def test_request_url_is_scrubbed
    event = exception_event
    event.request = { url: "https://u:p@shop.test/checkout?session=abc&step=2", method: "POST" }
    attributes = Attributes.log_record(event).attributes
    assert_equal "https://shop.test/checkout?session=[Filtered]&step=2", attributes["url.full"]
    assert_equal "/checkout", attributes["url.path"]
    assert_equal "POST", attributes["http.request.method"]
  end

  def test_urls_in_metadata_are_scrubbed
    url = "https://user:pw@example.com/?token=abc&card=4111111111111111&plan=pro"
    filtered = "https://example.com/?token=[Filtered]&card=[Filtered]&plan=pro"
    scope = Instatus::Scope.new
    scope.set_tags("callback" => url)
    scope.set_context("webhook", { "target" => url, "targets" => [{ "url" => url }] })
    scope.set_extra("url", url)
    scope.set_extra("request", { "links" => [url], "next" => { "href" => url } })
    attributes = Attributes.log_record(scope.apply(exception_event)).attributes

    assert_equal filtered, attributes["callback"]
    assert_equal filtered, attributes["webhook.target"]
    assert_equal [{ "url" => filtered }], JSON.parse(attributes["webhook.targets"])
    assert_equal filtered, attributes["extra.url"]
    assert_equal({ "links" => [filtered], "next" => { "href" => filtered } }, JSON.parse(attributes["extra.request"]))
  end

  def test_non_exceptions
    record = Attributes.log_record(Instatus::Event.from_exception("plain string", handled: true, mechanism: "generic"))
    assert_equal "RuntimeError: plain string", record.body
  end
end
