"""In-process throttling of failed sign-ins (ADR-0004).

Within a sliding window, one client address may fail `max_failures_per_account` times for a given
email and `max_failures_per_client` times in total. Past either limit its attempts are refused —
even with the right password — until the oldest failure leaves the window. Unknown and existing
emails are counted alike, so the throttle reveals nothing about which accounts exist.

State is in memory: per process and lost on restart. That fits the single-instance pilot; several
workers or instances would need a shared store (database table or Redis) instead.
"""

import math
import threading
import time
from collections import deque
from collections.abc import Callable

type ThrottleKey = tuple[str, str | None]

# Past this many tracked keys, every key is pruned on the next failure (bounded memory).
SWEEP_THRESHOLD = 10_000


class LoginThrottle:
    def __init__(
        self,
        *,
        max_failures_per_account: int = 5,
        max_failures_per_client: int = 20,
        window_seconds: float = 15 * 60,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._limits = (max_failures_per_account, max_failures_per_client)
        self._window = window_seconds
        self._clock = clock
        self._failures: dict[ThrottleKey, deque[float]] = {}
        self._lock = threading.Lock()

    def retry_after(self, email: str, client: str) -> int | None:
        """Seconds before `client` may try `email` again, or None when it may try now."""
        with self._lock:
            now = self._clock()
            waits = [
                failures[-limit] + self._window - now
                for key, limit in self._keyed_limits(email, client)
                if (failures := self._prune(key, now)) is not None and len(failures) >= limit
            ]
        return max(1, math.ceil(max(waits))) if waits else None

    def record_failure(self, email: str, client: str) -> None:
        with self._lock:
            now = self._clock()
            if len(self._failures) > SWEEP_THRESHOLD:
                for key in list(self._failures):
                    self._prune(key, now)
            for key, _ in self._keyed_limits(email, client):
                self._prune(key, now)
                self._failures.setdefault(key, deque()).append(now)

    def reset(self, email: str, client: str) -> None:
        """Forget the account's failures after a successful sign-in (the client total stays)."""
        with self._lock:
            self._failures.pop((client, email), None)

    def _keyed_limits(self, email: str, client: str) -> tuple[tuple[ThrottleKey, int], ...]:
        per_account, per_client = self._limits
        return (((client, email), per_account), ((client, None), per_client))

    def _prune(self, key: ThrottleKey, now: float) -> deque[float] | None:
        failures = self._failures.get(key)
        if failures is None:
            return None
        while failures and failures[0] <= now - self._window:
            failures.popleft()
        if not failures:
            del self._failures[key]
            return None
        return failures
