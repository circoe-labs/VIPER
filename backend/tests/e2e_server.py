"""API server for Playwright: synthetic data in the `*_test` database, then uvicorn.

Run from `backend/`: `python -m tests.e2e_server --port 8180` (Playwright starts it itself, see
`frontend/playwright.config.ts`). It RESETS `VIPER_TEST_DATABASE_URL` (name must end in `_test`), so
never run it while pytest uses the same database. The explorer is read-only, so the data stays
unchanged for the whole run.
"""

import argparse

import uvicorn

from app.core.config import Settings
from app.db.session import create_db_engine, create_session_factory, unit_of_work
from app.main import create_app
from tests.fixtures.synthetic.explorer_dataset import seed_explorer_dataset
from tests.support import require_test_database, reset_database


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    url = require_test_database(Settings().test_database_url)
    engine = create_db_engine(url)
    try:
        reset_database(engine, url)
        with unit_of_work(create_session_factory(engine)) as session:
            seed_explorer_dataset(session)
    finally:
        engine.dispose()
    uvicorn.run(create_app(Settings(database_url=url)), host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
