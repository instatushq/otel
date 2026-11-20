from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any, Callable, List, Optional

from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.trace import TracerProvider

from .client import Client


@dataclass
class Runtime:
    client: Client
    logger_provider: LoggerProvider
    tracer_provider: TracerProvider
    meter_provider: Optional[MeterProvider] = None
    cleanups: List[Callable[[], Any]] = field(default_factory=list)


lock = threading.RLock()
runtime: Optional[Runtime] = None
