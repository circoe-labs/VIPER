"""The application's own logs on stderr, so `docker logs` shows them.

Without this nothing configures logging: uvicorn sets up its own loggers only, and Python's last
resort handler drops everything below WARNING — the scheduled sending left no trace of what it
did. Messages carry identifiers and codes only (never an address, a subject or a body).
"""

import logging

FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"
_HANDLER_NAME = "viper-app"


def configure_logging() -> None:
    """INFO and above of every `app.*` logger to stderr; calling it again changes nothing."""
    logger = logging.getLogger("app")
    logger.setLevel(logging.INFO)
    if any(handler.get_name() == _HANDLER_NAME for handler in logger.handlers):
        return
    handler = logging.StreamHandler()
    handler.set_name(_HANDLER_NAME)
    handler.setFormatter(logging.Formatter(FORMAT))
    logger.addHandler(handler)
