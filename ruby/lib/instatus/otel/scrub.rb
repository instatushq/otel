# frozen_string_literal: true

require "set"
require "uri"

module Instatus
  module Otel
    module Scrub
      FILTERED = "[Filtered]"
      MAX_DEPTH = 6

      SENSITIVE_KEY = /pass(word|wd)?|secret|token|api[-_.]?key|auth|credential|session|cookie|csrf|xsrf|private[-_.]?key|signature/i
      CARD_NUMBER = /\b\d(?:[ -]?\d){12,18}\b/
      URL_CREDENTIALS = %r{\A([a-z][a-z0-9+.-]*://)[^/@?#]*@}i
      URL_PARAM = /([?&#])([^=&#]+)=([^&#]*)/
      URL = %r{\A[a-z][a-z0-9+.-]*://}i

      module_function

      def sensitive_key?(key)
        SENSITIVE_KEY.match?(key.to_s)
      end

      # The Luhn check keeps timestamps and order numbers of card length.
      def luhn?(digits)
        sum = digits.reverse.each_char.each_with_index.sum do |char, index|
          digit = index.odd? ? char.to_i * 2 : char.to_i
          digit > 9 ? digit - 9 : digit
        end
        (sum % 10).zero?
      end

      def scrub_text(text)
        text.to_s.gsub(CARD_NUMBER) { |match| luhn?(match.delete("^0-9")) ? FILTERED : match }
      end

      # A card number can sit in any parameter, so URLs get the text filter too.
      def scrub_url(url)
        without_credentials = url.to_s.sub(URL_CREDENTIALS, '\1')
        filtered = without_credentials.gsub(URL_PARAM) do |match|
          separator = Regexp.last_match(1)
          key = Regexp.last_match(2)
          sensitive_key?(decode(key)) ? "#{separator}#{key}=#{FILTERED}" : match
        end
        scrub_text(filtered)
      end

      def scrub_string(text)
        URL.match?(text) ? scrub_url(text) : scrub_text(text)
      end

      def scrub_value(key, value)
        scrub_nested(key.to_s, value, 0, Set.new.compare_by_identity)
      end

      def decode(value)
        URI.decode_www_form_component(value)
      rescue ArgumentError
        value
      end

      # ancestors is the current path only, so a value used twice is kept and only a cycle is cut.
      def scrub_nested(key, value, depth, ancestors)
        return FILTERED if sensitive_key?(key)
        return scrub_string(value) if value.is_a?(String)
        return value unless value.is_a?(Hash) || value.is_a?(Array)
        return "[Circular]" if ancestors.include?(value)
        return "[Truncated]" if depth >= MAX_DEPTH

        ancestors.add(value)
        scrubbed = scrub_children(value) { |child_key, child| scrub_nested(child_key, child, depth + 1, ancestors) }
        ancestors.delete(value)
        scrubbed
      end

      def scrub_children(value)
        if value.is_a?(Array)
          value.each_with_index.map { |child, index| yield(index.to_s, child) }
        else
          value.to_h { |key, child| [key, yield(key.to_s, child)] }
        end
      end
    end
  end
end
