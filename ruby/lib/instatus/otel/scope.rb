# frozen_string_literal: true

module Instatus
  class Scope
    attr_reader :user, :level, :tags, :extra, :contexts, :request

    def initialize
      clear
    end

    def initialize_copy(source)
      super
      @tags = source.tags.dup
      @extra = source.extra.dup
      @contexts = source.contexts.dup
    end

    def set_user(user)
      @user = user&.to_h
      self
    end

    def set_level(level)
      @level = level&.to_sym
      self
    end

    def set_tag(key, value)
      @tags[key.to_s] = value
      self
    end

    def set_tags(tags)
      tags.each { |key, value| set_tag(key, value) }
      self
    end

    def set_extra(key, value)
      @extra[key.to_s] = value
      self
    end

    def set_extras(extras)
      extras.each { |key, value| set_extra(key, value) }
      self
    end

    def set_context(name, context)
      if context.nil?
        @contexts.delete(name.to_s)
      else
        @contexts[name.to_s] = context
      end
      self
    end

    def set_request(url:, method: nil)
      @request = { url: url, method: method }.compact
      self
    end

    def update(user: nil, tags: nil, extra: nil, contexts: nil, level: nil)
      set_user(user) if user
      set_tags(tags) if tags
      set_extras(extra) if extra
      set_level(level) if level
      contexts&.each { |name, context| set_context(name, context) }
      self
    end

    def clear
      @user = nil
      @level = nil
      @request = nil
      @tags = {}
      @extra = {}
      @contexts = {}
      self
    end

    # Event values win over the scope's, as in Sentry: capture_exception(error, tags: {...}) beats set_tag.
    def apply(event)
      event.level = level || event.level
      event.user ||= user
      event.request ||= request
      event.tags = tags.merge(event.tags)
      event.extra = extra.merge(event.extra)
      event.contexts = contexts.merge(event.contexts)
      event
    end
  end
end
