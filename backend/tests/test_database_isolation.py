from sqlalchemy import Engine, text

from tests.support import transactional_session


def test_committed_work_does_not_leak_between_test_sessions(engine: Engine) -> None:
    with transactional_session(engine) as session:
        session.execute(text("CREATE TABLE isolation_probe (id integer)"))
        session.commit()
        assert session.execute(text("SELECT to_regclass('isolation_probe')")).scalar_one()

    with transactional_session(engine) as session:
        assert session.execute(text("SELECT to_regclass('isolation_probe')")).scalar_one() is None
