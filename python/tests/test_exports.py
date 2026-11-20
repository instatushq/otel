from __future__ import annotations

import pytest

from instatus_otel import __version__
from instatus_otel.exports import SignalExport, resolve_exports
from instatus_otel.resource import build_resource

HEADERS = {"Authorization": "Bearer sk_1", "X-Instatus-Site-Id": "site_1"}


def test_api_key_sends_every_signal_to_the_collector() -> None:
    assert resolve_exports("sk_1", "site_1", None, {}) == {
        "logs": SignalExport("https://otel.instatus.com/v1/logs", HEADERS),
        "traces": SignalExport("https://otel.instatus.com/v1/traces", HEADERS),
        "metrics": SignalExport("https://otel.instatus.com/v1/metrics", HEADERS),
    }


def test_keys_come_from_the_environment() -> None:
    env = {"INSTATUS_API_KEY": "sk_1", "INSTATUS_SITE_ID": "site_1"}
    assert resolve_exports(None, None, None, env)["logs"].headers == HEADERS


def test_site_id_is_optional() -> None:
    assert resolve_exports("sk_1", None, None, {})["traces"].headers == {
        "Authorization": "Bearer sk_1"
    }


def test_endpoint_replaces_the_host() -> None:
    exports = resolve_exports("sk_1", "site_1", "http://127.0.0.1:4318/", {})
    assert exports["logs"] == SignalExport("http://127.0.0.1:4318/v1/logs", HEADERS)
    assert exports["metrics"].url == "http://127.0.0.1:4318/v1/metrics"


def test_env_endpoint_is_left_to_the_exporter() -> None:
    env = {"OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector:4318"}
    exports = resolve_exports("sk_1", None, None, env)
    assert exports["logs"].url is None
    assert exports["logs"].headers == {"Authorization": "Bearer sk_1"}


def test_endpoint_without_a_key_sends_no_headers() -> None:
    exports = resolve_exports(None, None, "http://collector:4318", {})
    assert exports["traces"] == SignalExport("http://collector:4318/v1/traces", None)


def test_without_a_key_only_otel_variables_apply() -> None:
    env = {"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": "http://collector:4318/v1/traces"}
    assert resolve_exports(None, None, None, env) == {"traces": SignalExport()}
    assert resolve_exports(None, None, None, {}) == {}


def test_resource_attributes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OTEL_SERVICE_NAME", raising=False)
    monkeypatch.setenv("OTEL_RESOURCE_ATTRIBUTES", "team=payments,service.namespace=shop")
    attributes = build_resource("checkout", "api@1.4.0", "production").attributes
    assert attributes["service.name"] == "checkout"
    assert attributes["service.version"] == "api@1.4.0"
    assert attributes["deployment.environment.name"] == "production"
    assert attributes["telemetry.sdk.name"] == "instatus-otel"
    assert attributes["telemetry.sdk.version"] == __version__
    assert attributes["telemetry.sdk.language"] == "python"
    assert attributes["team"] == "payments"
    assert attributes["service.namespace"] == "shop"
    assert "process.pid" in attributes
    assert "host.name" in attributes


def test_service_name_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OTEL_SERVICE_NAME", "from-env")
    assert build_resource(None, None, None).attributes["service.name"] == "from-env"
    monkeypatch.delenv("OTEL_SERVICE_NAME")
    attributes = build_resource(None, None, None).attributes
    assert attributes["service.name"] == "python"
    assert "service.version" not in attributes
