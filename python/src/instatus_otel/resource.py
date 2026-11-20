from __future__ import annotations

import os
from typing import List, Mapping, Optional

from opentelemetry.sdk.resources import (
    SERVICE_NAME,
    ProcessResourceDetector,
    Resource,
    ResourceDetector,
    get_aggregated_resources,
)

from .attributes import Attributes
from .version import SDK_NAME, __version__

LANGUAGE = "python"
FALLBACK_SERVICE_NAME = "python"


# Sentry's release and environment are OpenTelemetry resource attributes.
def resource_attributes(
    service_name: Optional[str], release: Optional[str], environment: Optional[str]
) -> Attributes:
    attributes: Attributes = {
        "telemetry.sdk.name": SDK_NAME,
        "telemetry.sdk.version": __version__,
        "telemetry.sdk.language": LANGUAGE,
    }
    if service_name:
        attributes[SERVICE_NAME] = service_name
    if release:
        attributes["service.version"] = release
    if environment:
        attributes["deployment.environment.name"] = environment
    return attributes


def _detectors() -> List[ResourceDetector]:
    detectors: List[ResourceDetector] = [ProcessResourceDetector()]
    try:
        from opentelemetry.sdk.resources import _HostResourceDetector
    except ImportError:
        return detectors
    detectors.append(_HostResourceDetector())
    return detectors


# Detected host and process attributes come first, then OTEL_RESOURCE_ATTRIBUTES
# and OTEL_SERVICE_NAME, then the options, so an option always wins.
def build_resource(
    service_name: Optional[str],
    release: Optional[str],
    environment: Optional[str],
    env: Mapping[str, str] = os.environ,
) -> Resource:
    name = service_name or env.get("OTEL_SERVICE_NAME")
    detected = get_aggregated_resources(_detectors(), Resource.get_empty())
    resource = detected.merge(Resource.create(resource_attributes(name, release, environment)))
    current = str(resource.attributes.get(SERVICE_NAME, ""))
    if not current or current.startswith("unknown_service"):
        resource = resource.merge(Resource({SERVICE_NAME: FALLBACK_SERVICE_NAME}))
    return resource
