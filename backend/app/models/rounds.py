import uuid
import uuid

from sqlalchemy import TIMESTAMP, Column, ForeignKey, Integer, Numeric, SmallInteger, CheckConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from ..db import Base


class Round(Base):
    __tablename__ = "rounds"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    game_id = Column(UUID(as_uuid=True), ForeignKey("game.id", ondelete="SET NULL"))
    topic_id = Column(UUID(as_uuid=True), ForeignKey("topics.id", ondelete="SET NULL"))
    topic_difficulty = Column(SmallInteger, nullable=False, default=3)
    start_ts = Column(TIMESTAMP(timezone=True), server_default=func.now())
    end_ts = Column(TIMESTAMP(timezone=True))
    question_count = Column(SmallInteger)
    accuracy = Column(Numeric)  # 0..1
    avg_time_secs = Column(Numeric)
    hints = Column(Numeric)
    round_index = Column(Integer)

    __table_args__ = (
        CheckConstraint("topic_difficulty BETWEEN 1 AND 5", name="topic_difficulty_check"),
    )
