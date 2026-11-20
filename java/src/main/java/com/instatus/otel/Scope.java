package com.instatus.otel;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The user, tags, contexts and extras attached to the errors captured while it is current. Get
 * one from {@link Instatus#withScope}, {@link Instatus#getCurrentScope} or {@link
 * Instatus#getGlobalScope}.
 */
public final class Scope {
  private User user;
  private Level level;
  private String requestUrl;
  private final Map<String, String> tags = new LinkedHashMap<>();
  private final Map<String, Object> extra = new LinkedHashMap<>();
  private final Map<String, Map<String, Object>> contexts = new LinkedHashMap<>();

  /** Sets who is affected; null clears it. */
  public synchronized Scope setUser(User user) {
    this.user = user == null ? null : user.copy();
    return this;
  }

  public synchronized User getUser() {
    return user == null ? null : user.copy();
  }

  /** Overrides the level of every event captured in this scope. */
  public synchronized Scope setLevel(Level level) {
    this.level = level;
    return this;
  }

  public synchronized Level getLevel() {
    return level;
  }

  /** Sends the tag as an attribute named after the key. A null value removes it. */
  public synchronized Scope setTag(String key, String value) {
    if (key == null) return this;
    if (value == null) tags.remove(key);
    else tags.put(key, value);
    return this;
  }

  public synchronized Scope setTags(Map<String, String> tags) {
    if (tags == null) return this;
    tags.forEach(this::setTag);
    return this;
  }

  public synchronized Map<String, String> getTags() {
    return Collections.unmodifiableMap(new LinkedHashMap<>(tags));
  }

  /** Sends the value as {@code extra.<key>}. A null value removes it. */
  public synchronized Scope setExtra(String key, Object value) {
    if (key == null) return this;
    if (value == null) extra.remove(key);
    else extra.put(key, value);
    return this;
  }

  public synchronized Map<String, Object> getExtras() {
    return Collections.unmodifiableMap(new LinkedHashMap<>(extra));
  }

  /** Sends each entry as {@code <name>.<key>}. A null context removes it. */
  public synchronized Scope setContext(String name, Map<String, ?> context) {
    if (name == null) return this;
    if (context == null) contexts.remove(name);
    else contexts.put(name, new LinkedHashMap<>(context));
    return this;
  }

  public synchronized Map<String, Map<String, Object>> getContexts() {
    Map<String, Map<String, Object>> copy = new LinkedHashMap<>();
    contexts.forEach((name, context) -> copy.put(name, Collections.unmodifiableMap(context)));
    return Collections.unmodifiableMap(copy);
  }

  /** The URL being served, sent as {@code url.full} and {@code url.path} without its secrets. */
  public synchronized Scope setRequestUrl(String requestUrl) {
    this.requestUrl = requestUrl;
    return this;
  }

  public synchronized String getRequestUrl() {
    return requestUrl;
  }

  public synchronized Scope clear() {
    user = null;
    level = null;
    requestUrl = null;
    tags.clear();
    extra.clear();
    contexts.clear();
    return this;
  }

  synchronized Scope copy() {
    Scope copy = new Scope();
    copy.user = user == null ? null : user.copy();
    copy.level = level;
    copy.requestUrl = requestUrl;
    copy.tags.putAll(tags);
    copy.extra.putAll(extra);
    contexts.forEach((name, context) -> copy.contexts.put(name, new LinkedHashMap<>(context)));
    return copy;
  }

  synchronized void applyTo(Event event) {
    if (user != null) event.setUser(user.copy());
    if (level != null) event.setLevel(level);
    if (requestUrl != null) event.setRequestUrl(requestUrl);
    event.getTags().putAll(tags);
    event.getExtra().putAll(extra);
    contexts.forEach((name, context) -> event.getContexts().put(name, new LinkedHashMap<>(context)));
  }
}
