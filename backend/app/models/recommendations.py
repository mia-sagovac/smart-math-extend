from sqlalchemy import Column, Text, Numeric, ForeignKey, CheckConstraint, TIMESTAMP, SmallInteger, Integer, Enum
from sqlalchemy.dialects.postgresql import UUID
import uuid
from ..db import Base
from sqlalchemy.sql import func
import enum

class AlgorithmType(enum.Enum):
    logistic = "logistic"
    decision_tree = "decision_tree"
    ebm = "ebm"

class Recommendation(Base):
    __tablename__ = "recommendations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    round_id = Column(UUID(as_uuid=True), ForeignKey("rounds.id", ondelete="CASCADE"))
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    rec = Column(Text)
    confidence = Column(Numeric)
    prev_difficulty = Column(SmallInteger, nullable=False)
    new_difficulty = Column(SmallInteger, nullable=False)
    round_index = Column(Integer)
    true_label = Column(Integer)
    labeled_at = Column(TIMESTAMP(timezone=True))
    algorithm = Column(Enum(AlgorithmType), nullable=True)

    __table_args__ = (
        CheckConstraint("rec IN ('up','same','down')", name="rec_check"),
        CheckConstraint("prev_difficulty BETWEEN 1 AND 5",name="prev_difficulty_check"),
        CheckConstraint("new_difficulty BETWEEN 1 AND 5",name="new_difficulty_check"),
    )
