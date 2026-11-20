package com.instatus.otel;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.io.IOException;
import java.io.InputStream;
import java.util.Properties;
import org.junit.jupiter.api.Test;

class VersionTest {
  @Test
  void matchesThePom() throws IOException {
    Properties properties = new Properties();
    try (InputStream input = VersionTest.class.getResourceAsStream("/instatus-otel.properties")) {
      properties.load(input);
    }
    assertEquals(properties.getProperty("version"), Version.VERSION);
  }
}
