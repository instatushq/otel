# frozen_string_literal: true

module Instatus
  module Otel
    class RateCap
      def initialize(limit, window_seconds, clock: -> { Process.clock_gettime(Process::CLOCK_MONOTONIC) })
        @limit = limit
        @window = window_seconds
        @clock = clock
        @window_start = clock.call
        @count = 0
        @mutex = Mutex.new
      end

      def take
        @mutex.synchronize do
          now = @clock.call
          if now - @window_start >= @window
            @window_start = now
            @count = 0
          end
          next false if @count >= @limit

          @count += 1
          true
        end
      end
    end
  end
end
