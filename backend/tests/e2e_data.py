"""Load the synthetic explorer dataset into the Playwright database (E2E global setup).

Run from `backend/` against a freshly migrated, empty schema, with `VIPER_DATABASE_URL` pointing at
it: `python -m tests.e2e_data`. Refuses any database whose name does not end in `_e2e`, so
synthetic rows never reach a real database.
"""

import sys

from sqlalchemy import make_url

from app.core.config import Settings
from app.db.session import create_db_engine, create_session_factory, unit_of_work
from tests.fixtures.synthetic.explorer_dataset import seed_explorer_dataset


def main() -> int:
    url = Settings().database_url
    database = make_url(url).database or ""
    if not database.endswith("_e2e"):
        print(f"Refusing to load E2E data into {database!r}: its name must end with '_e2e'.")
        return 1
    engine = create_db_engine(url)
    try:
        with unit_of_work(create_session_factory(engine)) as session:
            seed_explorer_dataset(session)
    finally:
        engine.dispose()
    return 0


if __name__ == "__main__":
    sys.exit(main())
