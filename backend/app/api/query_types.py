"""Query-parameter types shared by the list routes."""

from typing import Annotated, Literal, TypeVar

from fastapi import Query

from app.repositories.filter_conditions import DEPARTMENT_PATTERN

OrNone = Literal["none"]
# A repeatable parameter (`?role=a&role=b`; a single `?role=a` is a selection of one).
T = TypeVar("T")
Many = Annotated[list[T] | None, Query()]
Department = Annotated[str, Query(pattern=DEPARTMENT_PATTERN)]
