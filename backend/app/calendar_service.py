"""Compatibility names for existing clients; all writes use the canonical plan service."""

from .plans import (
    PlanBatch as EventBatch,
)
from .plans import (
    PlanRead as EventRead,
)
from .plans import (
    PlanWrite as EventWrite,
)
from .plans import (
    create_events,
    delete_event,
    find,
    list_events,
    update_event,
)

__all__ = [
    "EventBatch",
    "EventRead",
    "EventWrite",
    "create_events",
    "delete_event",
    "find",
    "list_events",
    "update_event",
]
