from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Mapping, Optional

DEFAULT_ENDPOINT = "https://otel.instatus.com"
SIGNALS = ("logs", "traces", "metrics")


# url None leaves the OTLP exporter to read OTEL_EXPORTER_OTLP_* itself, and
# headers None lets it read OTEL_EXPORTER_OTLP_HEADERS too.
@dataclass(frozen=True)
class SignalExport:
    url: Optional[str] = None
    headers: Optional[Dict[str, str]] = field(default=None)


def _has_env_endpoint(env: Mapping[str, str], signal: str) -> bool:
    return bool(
        env.get(f"OTEL_EXPORTER_OTLP_{signal.upper()}_ENDPOINT")
        or env.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    )


def _signal_url(endpoint: str, signal: str) -> str:
    return f"{endpoint.rstrip('/')}/v1/{signal}"


def _url_for(endpoint: Optional[str], env: Mapping[str, str], signal: str) -> Optional[str]:
    if endpoint:
        return _signal_url(endpoint, signal)
    if _has_env_endpoint(env, signal):
        return None
    return _signal_url(DEFAULT_ENDPOINT, signal)


# An API key sends every signal to the Instatus collector. Without one, an
# endpoint or the standard OTEL_EXPORTER_OTLP_* variables decide.
def resolve_exports(
    api_key: Optional[str],
    site_id: Optional[str],
    endpoint: Optional[str],
    env: Mapping[str, str],
) -> Dict[str, SignalExport]:
    key = api_key or env.get("INSTATUS_API_KEY")
    site = site_id or env.get("INSTATUS_SITE_ID")
    if key:
        headers = {"Authorization": f"Bearer {key}"}
        if site:
            headers["X-Instatus-Site-Id"] = site
        return {
            signal: SignalExport(_url_for(endpoint, env, signal), headers) for signal in SIGNALS
        }
    if endpoint:
        return {signal: SignalExport(_signal_url(endpoint, signal)) for signal in SIGNALS}
    return {signal: SignalExport() for signal in SIGNALS if _has_env_endpoint(env, signal)}
