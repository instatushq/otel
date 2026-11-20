package com.instatus.otel;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Who an error affected. The id (or email, or username) becomes {@code enduser.id}, and every
 * field becomes {@code user.<key>}.
 */
public final class User {
  private String id;
  private String email;
  private String username;
  private String ipAddress;
  private final Map<String, Object> data = new LinkedHashMap<>();

  public String getId() {
    return id;
  }

  public User setId(String id) {
    this.id = id;
    return this;
  }

  public String getEmail() {
    return email;
  }

  public User setEmail(String email) {
    this.email = email;
    return this;
  }

  public String getUsername() {
    return username;
  }

  public User setUsername(String username) {
    this.username = username;
    return this;
  }

  public String getIpAddress() {
    return ipAddress;
  }

  public User setIpAddress(String ipAddress) {
    this.ipAddress = ipAddress;
    return this;
  }

  /** Any other field, sent as {@code user.<key>}. A null value removes it. */
  public User set(String key, Object value) {
    if (key == null) return this;
    if (value == null) data.remove(key);
    else data.put(key, value);
    return this;
  }

  public Map<String, Object> getData() {
    return Collections.unmodifiableMap(data);
  }

  User copy() {
    User copy = new User().setId(id).setEmail(email).setUsername(username).setIpAddress(ipAddress);
    copy.data.putAll(data);
    return copy;
  }

  String endUserId() {
    if (id != null && !id.isEmpty()) return id;
    if (email != null && !email.isEmpty()) return email;
    if (username != null && !username.isEmpty()) return username;
    return null;
  }

  Map<String, Object> fields() {
    Map<String, Object> fields = new LinkedHashMap<>();
    if (id != null) fields.put("id", id);
    if (email != null) fields.put("email", email);
    if (username != null) fields.put("username", username);
    if (ipAddress != null) fields.put("ip_address", ipAddress);
    fields.putAll(data);
    return fields;
  }
}
