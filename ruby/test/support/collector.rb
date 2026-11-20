# frozen_string_literal: true

require "webrick"
require "zlib"

class Collector
  Request = Struct.new(:path, :headers, :body)

  attr_reader :endpoint

  def initialize
    @received = Queue.new
    @server = WEBrick::HTTPServer.new(Port: 0, BindAddress: "127.0.0.1", Logger: WEBrick::Log.new(File::NULL),
                                      AccessLog: [])
    @server.mount_proc("/") { |request, response| record(request, response) }
    @endpoint = "http://127.0.0.1:#{@server.config[:Port]}"
    @thread = Thread.new { @server.start }
  end

  def requests
    items = []
    items << @received.pop until @received.empty?
    items
  end

  def stop
    @server.shutdown
    @thread.join
  end

  def self.attribute_map(attributes)
    attributes.to_h do |attribute|
      value = attribute.value
      [attribute.key, value[value.value.to_s]]
    end
  end

  def self.log_records(requests)
    requests.select { |request| request.path == "/v1/logs" }.flat_map do |request|
      export = Opentelemetry::Proto::Collector::Logs::V1::ExportLogsServiceRequest.decode(request.body)
      export.resource_logs.flat_map(&:scope_logs).flat_map(&:log_records)
    end
  end

  private

  def record(request, response)
    body = request.body.to_s
    body = Zlib.gunzip(body) if request["Content-Encoding"] == "gzip"
    headers = %w[Authorization X-Instatus-Site-Id Content-Type].to_h { |name| [name.downcase, request[name]] }
    @received << Request.new(request.path, headers, body)
    response.status = 200
    response["Content-Type"] = "application/x-protobuf"
  end
end
