package com.instatus.otel;

import io.opentelemetry.api.logs.Severity;

/** Sentry's event levels and the OpenTelemetry severity each one is sent with. */
public enum Level {
  DEBUG(Severity.DEBUG, "DEBUG"),
  INFO(Severity.INFO, "INFO"),
  WARNING(Severity.WARN, "WARN"),
  ERROR(Severity.ERROR, "ERROR"),
  FATAL(Severity.FATAL, "FATAL");

  private final Severity severity;
  private final String severityText;

  Level(Severity severity, String severityText) {
    this.severity = severity;
    this.severityText = severityText;
  }

  public Severity getSeverity() {
    return severity;
  }

  public int getSeverityNumber() {
    return severity.getSeverityNumber();
  }

  public String getSeverityText() {
    return severityText;
  }

  boolean isError() {
    return severity.getSeverityNumber() >= Severity.ERROR.getSeverityNumber();
  }
}
