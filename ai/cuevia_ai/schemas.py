"""Pydantic models for the private AI contract v1 (contracts/ai-v1.md, owned by backend).

Field names and shapes mirror the shared contract exactly. Do not rename fields without a
versioned contract change agreed by the team.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

Uncertainty = Literal["low", "medium", "high"]
Depth = Literal["simple", "standard", "advanced"]

MAX_SEGMENTS = 400
MAX_SEGMENT_TEXT = 5_000
MAX_CV_CHARS = 60_000


class _In(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---- shared types -------------------------------------------------------------------------

class Segment(_In):
    id: str = Field(min_length=1, max_length=200)
    sequence: int
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)
    text: str = Field(default="", max_length=MAX_SEGMENT_TEXT)
    status: Literal["ready", "gap"]


class Source(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    title: str = Field(max_length=500)
    url: str = Field(max_length=2048)


class TopicEvidence(BaseModel):
    topic: str = Field(min_length=1, max_length=200)
    baseline: Optional[float] = Field(default=None, ge=0, le=100)
    uncertainty: Uncertainty
    evidence: list[str] = Field(default_factory=list, max_length=10)


class Skill(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    evidence: str = Field(max_length=1000)


class HealthResponse(_Out):
    status: Literal["ok"] = "ok"
    service: str
    contract_version: str


# ---- /profile -----------------------------------------------------------------------------

class ProfileRequest(_In):
    cv_text: str = Field(min_length=1, max_length=MAX_CV_CHARS)
    event_topics: list[str] = Field(default_factory=list, max_length=50)


class ProfileResponse(_Out):
    skills: list[Skill]
    topic_estimates: list[TopicEvidence]
    interests: list[str]
    model_id: str


# ---- /transcribe --------------------------------------------------------------------------

class TranscribeResponse(_Out):
    text: str
    model_id: str


# ---- /catch-up ----------------------------------------------------------------------------

class CatchUpRequest(_In):
    segments: list[Segment] = Field(max_length=MAX_SEGMENTS)
    locale: str = Field(default="sr", max_length=20)


class CatchUpResponse(_Out):
    cue: str
    summary: str
    source_segment_ids: list[str]
    model_id: str


# ---- /explain -----------------------------------------------------------------------------

class ExplainRequest(_In):
    term: str = Field(min_length=1, max_length=200)
    segments: list[Segment] = Field(default_factory=list, max_length=MAX_SEGMENTS)
    background: list[TopicEvidence] = Field(default_factory=list, max_length=50)
    depth: Depth = "standard"
    locale: str = Field(default="sr", max_length=20)
    provided_sources: list[Source] = Field(default_factory=list, max_length=20)


class ExplainResponse(_Out):
    explanation: str
    example: str
    sources: list[Source]
    retrieval_mode: Literal["web", "provided", "general"]
    model_id: str


# ---- /evaluate-question -------------------------------------------------------------------

class EvaluateQuestionRequest(BaseModel):
    # extra="forbid": the judge must never receive identity/CV/privilege fields. A request that
    # carries anything beyond the contract is rejected instead of silently ignored.
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    question_text: str = Field(min_length=1, max_length=2000)
    segments: list[Segment] = Field(default_factory=list, max_length=MAX_SEGMENTS)
    submitted_at: str
    window_start_at: str
    allowed_topics: list[str] = Field(default_factory=list, max_length=100)
    context_available: bool
    locale: str = Field(default="sr", max_length=20)

    @field_validator("submitted_at", "window_start_at")
    @classmethod
    def _rfc3339(cls, v: str) -> str:
        from datetime import datetime

        try:
            datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("must be an RFC3339 timestamp") from exc
        return v


class QuestionTopic(BaseModel):
    topic: str = Field(min_length=1, max_length=200)
    evidence: str = Field(max_length=2000)
    confidence: Uncertainty


class Rationale(BaseModel):
    relevance: str = Field(max_length=600)
    expertise: str = Field(max_length=600)
    depth: str = Field(max_length=600)


class AIQuestionEvaluation(_Out):
    relevance: Optional[float] = Field(default=None, ge=0, le=10)
    expertise: Optional[float] = Field(default=None, ge=0, le=10)
    depth: Optional[float] = Field(default=None, ge=0, le=10)
    topics: list[QuestionTopic]
    rationale: Rationale
    source_segment_ids: list[str]
    context_status: Literal["sufficient", "insufficient"]
    is_generic_clarification: bool
    model_id: str
    rubric_version: str


# ---- /match -------------------------------------------------------------------------------

class Opportunity(_In):
    id: str = Field(min_length=1, max_length=200)
    title: str = Field(max_length=300)
    topics: list[str] = Field(default_factory=list, max_length=50)
    required_skills: list[str] = Field(default_factory=list, max_length=50)


class ProfileEvidence(_In):
    skills: list[Skill] = Field(default_factory=list, max_length=100)
    interests: list[str] = Field(default_factory=list, max_length=100)


class MatchQuestion(_In):
    text: str = Field(max_length=2000)
    topics: list[str] = Field(default_factory=list, max_length=20)


class MatchRequest(_In):
    opportunity: Opportunity
    profile_evidence: ProfileEvidence
    questions: list[MatchQuestion] = Field(default_factory=list, max_length=50)


class MatchResponse(_Out):
    reasons: list[str]
    missing_requirements: list[str]
    supported_question_indices: list[int]
    model_id: str
