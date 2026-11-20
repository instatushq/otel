# frozen_string_literal: true

require "test_helper"

class ScopeTest < Minitest::Test
  include ClientHelpers

  def test_with_scope_gives_a_copy
    Instatus.set_tag("region", "eu")
    Instatus.with_scope do |scope|
      scope.set_tag("job", "42")
      assert_equal({ "region" => "eu", "job" => "42" }, Instatus.current_scope.tags)
    end
    assert_equal({ "region" => "eu" }, Instatus.current_scope.tags)
  end

  def test_nested_with_scope
    Instatus.with_scope do |outer|
      outer.set_tag("a", 1)
      Instatus.with_scope do |inner|
        inner.set_tag("b", 2)
        assert_equal({ "a" => 1, "b" => 2 }, Instatus.current_scope.tags)
      end
      assert_equal({ "a" => 1 }, Instatus.current_scope.tags)
    end
  end

  def test_threads_have_their_own_copy
    Instatus.set_tag("region", "eu")
    ready = Queue.new
    go = Queue.new
    threads = %w[ada grace].map do |name|
      Thread.new do
        Instatus.set_user(id: name)
        Instatus.set_tag("worker", name)
        ready << true
        go.pop
        [Instatus.current_scope.user, Instatus.current_scope.tags]
      end
    end
    2.times { ready.pop }
    2.times { go << true }
    results = threads.map(&:value)

    assert_equal [{ id: "ada" }, { "region" => "eu", "worker" => "ada" }], results[0]
    assert_equal [{ id: "grace" }, { "region" => "eu", "worker" => "grace" }], results[1]
    assert_nil Instatus.current_scope.user
    assert_equal({ "region" => "eu" }, Instatus.current_scope.tags)
  end

  def test_with_scope_is_per_fiber
    Instatus.with_scope do |scope|
      scope.set_tag("outer", true)
      fiber = Fiber.new { Instatus.current_scope.tags }
      refute fiber.resume.key?("outer")
    end
  end

  def test_capture_uses_the_current_scope_and_event_values_win
    client, sink = build_client
    with_client(client) do
      Instatus.with_scope do |scope|
        scope.set_tag("plan", "free")
        scope.set_user(id: 7)
        Instatus.capture_exception(raised, tags: { plan: "pro" }, extra: { order: 9 })
      end
    end
    attributes = sink.records.first.first.attributes
    assert_equal "pro", attributes["plan"]
    assert_equal 9, attributes["extra.order"]
    assert_equal "7", attributes["enduser.id"]
  end

  def test_capture_with_a_block
    client, sink = build_client
    with_client(client) do
      Instatus.capture_message("Slow", level: :warning) { |scope| scope.set_context("db", { ms: 900 }) }
    end
    record = sink.records.first.first
    assert_equal 13, record.severity_number
    assert_equal 900, record.attributes["db.ms"]
    refute Instatus.current_scope.contexts.key?("db")
  end

  def test_set_context_nil_removes_it
    scope = Instatus::Scope.new.set_context("cart", { items: 1 })
    assert_empty scope.set_context("cart", nil).contexts
  end
end
