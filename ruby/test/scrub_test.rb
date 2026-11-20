# frozen_string_literal: true

require "test_helper"

class ScrubTest < Minitest::Test
  Scrub = Instatus::Otel::Scrub

  def test_sensitive_keys
    %w[password passwd pass secret api_key apiKey api-key Authorization session_id csrf_token X-XSRF
       private_key signature credentials cookie].each do |key|
      assert Scrub.sensitive_key?(key), key
    end
    %w[user plan region count].each { |key| refute Scrub.sensitive_key?(key), key }
  end

  def test_card_numbers_that_pass_luhn
    assert_equal "paid with [Filtered] today", Scrub.scrub_text("paid with 4111 1111 1111 1111 today")
    assert_equal "card [Filtered]", Scrub.scrub_text("card 5500-0000-0000-0004")
    assert_equal "[Filtered]", Scrub.scrub_text("4242424242424242")
  end

  def test_digits_that_fail_luhn_stay
    assert_equal "order 4111111111111112", Scrub.scrub_text("order 4111111111111112")
    assert_equal "at 1700000000000", Scrub.scrub_text("at 1700000000000")
    assert_equal "id 123456789012", Scrub.scrub_text("id 123456789012")
  end

  def test_url_credentials_and_params
    url = "https://admin:hunter2@example.com/pay?token=abc&plan=pro&api_key=k#access_token=xyz"
    assert_equal "https://example.com/pay?token=[Filtered]&plan=pro&api_key=[Filtered]#access_token=[Filtered]",
                 Scrub.scrub_url(url)
  end

  def test_url_encoded_param_names_and_card_numbers
    assert_equal "https://example.com/?api%5Fkey=[Filtered]", Scrub.scrub_url("https://example.com/?api%5Fkey=1")
    assert_equal "https://example.com/?number=[Filtered]", Scrub.scrub_url("https://example.com/?number=4111111111111111")
  end

  def test_values_that_look_like_urls_get_the_url_filter
    assert_equal "HTTPS://example.com/?token=[Filtered]", Scrub.scrub_value("link", "HTTPS://a:b@example.com/?token=abc")
    assert_equal ["postgres://db/app?password=[Filtered]"], Scrub.scrub_value("dsns", ["postgres://u:p@db/app?password=x"])
    assert_equal "paid [Filtered] at ?token=abc", Scrub.scrub_value("note", "paid 4111111111111111 at ?token=abc")
  end

  def test_nested_hashes_and_arrays
    value = {
      "request" => { password: "p", "headers" => { "Authorization" => "Bearer x", "Accept" => "json" } },
      "cards" => ["4111 1111 1111 1111", { "token" => "t", "last4" => "1111" }]
    }
    assert_equal(
      {
        "request" => { password: "[Filtered]", "headers" => { "Authorization" => "[Filtered]", "Accept" => "json" } },
        "cards" => ["[Filtered]", { "token" => "[Filtered]", "last4" => "1111" }]
      },
      Scrub.scrub_value("payload", value)
    )
  end

  def test_value_under_sensitive_key_is_filtered_whole
    assert_equal "[Filtered]", Scrub.scrub_value("session", { "id" => 1 })
  end

  def test_cycles_are_cut_and_shared_values_kept
    address = { "city" => "Paris" }
    value = { "billing" => address, "shipping" => address }
    value["self"] = value
    list = [1]
    list << list

    scrubbed = Scrub.scrub_value("order", value)
    assert_equal({ "city" => "Paris" }, scrubbed["billing"])
    assert_equal({ "city" => "Paris" }, scrubbed["shipping"])
    assert_equal "[Circular]", scrubbed["self"]
    assert_equal [1, "[Circular]"], Scrub.scrub_value("list", list)
  end

  def test_depth_is_capped
    deep = { "a" => { "b" => { "c" => { "d" => { "e" => { "f" => { "g" => 1 } } } } } } }
    assert_equal "[Truncated]", Scrub.scrub_value("deep", deep).dig("a", "b", "c", "d", "e", "f")
  end

  def test_other_values_pass_through
    assert_equal 42, Scrub.scrub_value("count", 42)
    assert_nil Scrub.scrub_value("missing", nil)
  end
end
