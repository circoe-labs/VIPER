"""Creation-date filters use whole calendar days in the application's business time zone."""

from datetime import date, datetime, timedelta

from sqlalchemy import ColumnElement, SQLColumnExpression

from app.core.business_time import start_of_day


def created_between(
    column: SQLColumnExpression[datetime], since: date | None, until: date | None
) -> list[ColumnElement[bool]]:
    conditions = []
    if since is not None:
        conditions.append(column >= start_of_day(since))
    if until is not None and until < date.max:
        conditions.append(column < start_of_day(until + timedelta(days=1)))
    return conditions
