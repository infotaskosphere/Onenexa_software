"""Canonical CompliGenie due-date Pydantic models."""
import uuid
from typing import Optional, Any, List, Dict
from datetime import datetime, date
from pydantic import BaseModel, ConfigDict, Field, field_validator

class DueDateBase(BaseModel):
    title: str
    description: Optional[str] = None
    due_date: Any
    reminder_days: int = 30
    category: Optional[str] = None
    department: str
    assigned_to: Optional[str] = None
    client_id: Optional[str] = None
    status: str = "pending"

    @field_validator("due_date", mode="before")
    @classmethod
    def coerce_due_date(cls, v: Any) -> Any:
        if v is None or v == "":
            raise ValueError("due_date is required")
        if isinstance(v, (date, datetime)):
            return v
        if isinstance(v, str):
            try:
                return datetime.fromisoformat(v)
            except ValueError:
                pass
            try:
                return date.fromisoformat(v)
            except ValueError:
                raise ValueError(f"Invalid due_date format: {v}")
        return v

    @field_validator("reminder_days", mode="before")
    @classmethod
    def coerce_reminder_days(cls, v: Any) -> int:
        if v is None:
            return 30
        try:
            return int(v)
        except (TypeError, ValueError):
            return 30

    @field_validator("department", mode="before")
    @classmethod
    def coerce_department(cls, v: Any) -> str:
        if v is None or str(v).strip() == "":
            raise ValueError("department is required")
        return str(v).strip()


class DueDateCreate(DueDateBase):
    pass


class DueDate(DueDateBase):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_by: str
    created_at: Optional[Any] = None

    @field_validator("created_at", mode="before")
    @classmethod
    def coerce_created_at(cls, v: Any) -> Any:
        if v is None or v == "":
            return None
        if isinstance(v, datetime):
            return v
        if isinstance(v, str):
            try:
                return datetime.fromisoformat(v)
            except ValueError:
                return None
        return v
