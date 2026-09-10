"""In-process login throttle: sliding window per account and per client address."""

from app.services.login_throttle import LoginThrottle

EMAIL = "pilote.test@example.com"
CLIENT = "192.0.2.10"


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def throttle(clock: FakeClock) -> LoginThrottle:
    return LoginThrottle(
        max_failures_per_account=3, max_failures_per_client=5, window_seconds=60, clock=clock
    )


def test_account_is_refused_after_the_limit_until_the_oldest_failure_leaves_the_window() -> None:
    clock = FakeClock()
    limiter = throttle(clock)
    for offset in (0, 10, 20):
        clock.now = 1000 + offset
        assert limiter.retry_after(EMAIL, CLIENT) is None
        limiter.record_failure(EMAIL, CLIENT)

    assert limiter.retry_after(EMAIL, CLIENT) == 40
    clock.now = 1059.5
    assert limiter.retry_after(EMAIL, CLIENT) == 1
    clock.now = 1060
    assert limiter.retry_after(EMAIL, CLIENT) is None


def test_the_account_limit_is_per_client_address() -> None:
    limiter = throttle(FakeClock())
    for _ in range(3):
        limiter.record_failure(EMAIL, CLIENT)

    assert limiter.retry_after(EMAIL, "198.51.100.7") is None


def test_one_client_spraying_many_emails_hits_the_client_limit() -> None:
    limiter = throttle(FakeClock())
    for index in range(5):
        limiter.record_failure(f"inconnu{index}.test@example.com", CLIENT)

    assert limiter.retry_after("encore.test@example.com", CLIENT) is not None
    assert limiter.retry_after(EMAIL, "198.51.100.7") is None


def test_reset_clears_the_account_but_not_the_client_total() -> None:
    limiter = throttle(FakeClock())
    for _ in range(3):
        limiter.record_failure(EMAIL, CLIENT)
    limiter.reset(EMAIL, CLIENT)

    assert limiter.retry_after(EMAIL, CLIENT) is None
    limiter.record_failure(EMAIL, CLIENT)
    limiter.record_failure(EMAIL, CLIENT)
    assert limiter.retry_after(EMAIL, CLIENT) is not None


def test_expired_failures_are_forgotten() -> None:
    clock = FakeClock()
    limiter = throttle(clock)
    limiter.record_failure(EMAIL, CLIENT)
    clock.now += 61

    assert limiter.retry_after(EMAIL, CLIENT) is None
    assert limiter._failures == {}
