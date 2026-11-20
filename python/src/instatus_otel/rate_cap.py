from __future__ import annotations

import threading
import time
from typing import Callable


class RateCap:
    def __init__(
        self, limit: int, window_seconds: float, now: Callable[[], float] = time.monotonic
    ) -> None:
        self._limit = limit
        self._window = window_seconds
        self._now = now
        self._window_start = now()
        self._count = 0
        self._lock = threading.Lock()

    def take(self) -> bool:
        with self._lock:
            current = self._now()
            if current - self._window_start >= self._window:
                self._window_start = current
                self._count = 0
            if self._count >= self._limit:
                return False
            self._count += 1
            return True
