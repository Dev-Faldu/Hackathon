"""Pydantic response models that mirror contracts/README.md.

Each model checks the contract's fields and values; extra fields (used by the UI) are allowed through.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator, model_validator

C_APPROVERS = ["FBO general manager", "Airport operations", "FAA"]


class _Open(BaseModel):
    model_config = ConfigDict(extra="allow")


class Fact(_Open):
    id: str
    text: str


class Kpis(_Open):
    aircraft_accommodated: int
    hours_over_capacity: int
    empty_legs: int
    co2_t: float
    peak_line_staff: int
    fuel_gal_week: int
    risk: Literal["low", "medium", "high"]


class Strategy(_Open):
    id: Literal["A", "B", "C"]
    name: str
    kpis: Kpis
    approvers: list[str]
    assumptions: list[str]
    explanation_facts: list[Fact]

    @model_validator(mode="after")
    def _c_needs_faa(self):
        if self.id == "C" and self.approvers != C_APPROVERS:
            raise ValueError(f"strategy C must list approvers {C_APPROVERS}")
        return self


class StrategiesResponse(_Open):
    strategies: list[Strategy]

    @field_validator("strategies")
    @classmethod
    def _exactly_abc(cls, v: list[Strategy]):
        if [s.id for s in v] != ["A", "B", "C"]:
            raise ValueError("exactly three strategies, A, B and C")
        return v


class QueueItem(_Open):
    booking_code: str
    rank: int
    score: float
    slack_min: int | None
    reasons: list[str]

    @field_validator("reasons")
    @classmethod
    def _has_reasons(cls, v: list[str]):
        if not v:
            raise ValueError("every rank carries at least one plain-language reason")
        return v


class QueueResponse(_Open):
    weights: dict[str, float]
    items: list[QueueItem]


class Alert(_Open):
    id: str
    severity: Literal["info", "watch", "high"]
    kind: Literal["ramp_capacity", "customs_window", "curfew", "car_wrong_airport", "runway"]
    message: str
    recommended_action: str
    owner_role: str


class AlertsResponse(_Open):
    alerts: list[Alert]


class Explanation(_Open):
    text: str
    cited_ids: list[str]
    model: str
    fallback: bool


class WhatIfResponse(_Open):
    kpi_diff: dict[str, dict[str, list]]
    new_alerts: list[Alert]
    strategies: list[Strategy]
    explanation: Explanation


class AuditRow(_Open):
    t_utc: str
    actor_role: str
    action: Literal["propose", "approve", "edit", "reject"]
    target: str
    note: str
