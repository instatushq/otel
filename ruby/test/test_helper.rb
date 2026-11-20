# frozen_string_literal: true

$LOAD_PATH.unshift(File.expand_path("../lib", __dir__))

require "instatus/otel"
require "minitest/autorun"

module ClearGlobalScope
  def after_teardown
    Instatus.global_scope.clear
    super
  end
end

Minitest::Test.include(ClearGlobalScope)

class RecordingSink
  attr_reader :records

  def initialize
    @records = []
  end

  def emit(record, span_context)
    @records << [record, span_context]
  end

  def flush(_timeout)
    true
  end

  def close(_timeout)
    true
  end
end

module ClientHelpers
  def build_client(**options)
    config = Instatus::Configuration.new({})
    options.each { |key, value| config.public_send(:"#{key}=", value) }
    sink = RecordingSink.new
    [Instatus::Otel::Client.new(config, sink: sink), sink]
  end

  def raised(error_class = RuntimeError, message = "boom")
    raise error_class, message
  rescue error_class => e
    e
  end

  def with_client(client)
    previous = Instatus.instance_variable_get(:@client)
    Instatus.instance_variable_set(:@client, client)
    yield
  ensure
    Instatus.instance_variable_set(:@client, previous)
  end
end
