"""Public HTTP contract v1 models (contracts/http-v1.md).

These are the ONLY shapes serialized to browsers. None of them carries cv_baseline,
expertise estimates, relevance/expertise/depth, quality, bonus, scores or rank.
Every model forbids extra fields so a private value can never be passed through by accident.
"""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Public(BaseModel):
    model_config = ConfigDict(extra="forbid")


CvStatus = Literal["missing", "uploaded", "processing", "parsed", "failed", "removed"]
Depth = Literal["simple", "standard", "advanced"]


class Segment(Public):
    id: str
    sequence: int
    start_ms: int
    end_ms: int
    text: str
    status: Literal["ready", "gap"]


class Interest(Public):
    topic: str
    source: Literal["cv", "question", "declared"]


class ProfilePublic(Public):
    user_id: str
    cv_status: CvStatus
    expertise_status: Literal["N/A", "estimated"]
    interests: list[Interest]
    eligible_for_top5: bool


class QuestionPublic(Public):
    id: str
    talk_id: str
    text: str
    submitted_at: str
    read_status: Literal["unread", "read"]


class Source(Public):
    id: str
    title: str
    url: str


class CatchUp(Public):
    cue: str
    summary: str
    source_segment_ids: list[str]
    start_ms: int
    end_ms: int


class Explanation(Public):
    explanation: str
    example: str
    sources: list[Source]
    retrieval_mode: Literal["web", "provided", "general"]


class Me(Public):
    user_id: str
    display_name: str
    roles: list[str]


class EventItem(Public):
    id: str
    title: str


class EventList(Public):
    items: list[EventItem]
    next_cursor: str | None


class Joined(Public):
    joined: Literal[True] = True


class TalkItem(Public):
    id: str
    title: str
    speaker_name: str
    status: Literal["scheduled", "live", "ended"]


class TalkList(Public):
    items: list[TalkItem]


class CvAccepted(Public):
    cv_status: Literal["processing"] = "processing"


class ProfilePatch(Public):
    declared_interests: list[str] = Field(max_length=20)


class RecordingStarted(Public):
    recording_id: str
    mode: Literal["live", "replay"]
    started_at: str
    sample_rate_hz: int
    chunk_seconds: int


class ChunkAccepted(Public):
    sequence: int
    status: Literal["accepted"] = "accepted"


class SegmentPage(Public):
    items: list[Segment]
    next_after_sequence: int
    processing_lag_ms: int


class Stopped(Public):
    status: Literal["stopped"] = "stopped"


class CatchUpRequest(Public):
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)


class ExplainRequest(Public):
    selected_text: str = Field(min_length=1, max_length=120)
    segment_id: str = Field(min_length=1, max_length=64)
    depth: Depth = "standard"


class Quota(Public):
    used: int
    limit: int
    remaining: int


class QuestionList(Public):
    items: list[QuestionPublic]


class QuestionCreate(Public):
    text: str = Field(min_length=1, max_length=500)
    client_request_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_\-:.]+$")


class QuestionCreated(Public):
    question: QuestionPublic
    quota: Quota


class ReadStatusPatch(Public):
    read_status: Literal["read"]


class Opportunity(Public):
    id: str
    recipient_id: str
    recipient_kind: Literal["sponsor", "group"]
    title: str
    topics: list[str]


class OpportunityList(Public):
    items: list[Opportunity]


class OpportunityCreate(Public):
    title: str = Field(min_length=1, max_length=200)
    topics: list[str] = Field(min_length=1, max_length=10)
    required_skills: list[str] = Field(default_factory=list, max_length=20)


class Created(Public):
    id: str


class ConsentBody(Public):
    allow_cv: bool
    allow_questions: bool


class Consent(Public):
    recipient_id: str
    allow_cv: bool
    allow_questions: bool


class Recommendation(Public):
    participant_id: str
    display_name: str
    interests: list[Interest]
    reasons: list[str]
    questions: list[QuestionPublic]
    cv_available: bool


class RecommendationList(Public):
    items: list[Recommendation]


class TranscriptSourceBody(Public):
    recording_id: str


class Configured(Public):
    configured: Literal[True] = True


class Finalized(Public):
    snapshot_id: str
    status: Literal["finalized"] = "finalized"


class TermCount(Public):
    term: str
    count: int


class TopicCount(Public):
    topic: str
    count: int


class Metrics(Public):
    attendee_count: int
    cv_parsed_count: int
    na_count: int
    question_count: int
    catch_up_count: int
    requested_terms: list[TermCount]
    interest_distribution: list[TopicCount]
    share_count: int
