from sqlalchemy import Column, Text, TIMESTAMP, ForeignKey, CheckConstraint, Enum
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func
import uuid
from ..db import Base
import enum


class AlgorithmType(enum.Enum):
    logistic = "logistic"
    decision_tree = "decision_tree"
    ebm = "ebm"


class Game(Base):
    __tablename__ = "game"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    game_code = Column(Text, unique=True, nullable=False)
    teacher_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    status = Column(Text, nullable=False)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    end_time = Column(TIMESTAMP(timezone=True))
    algorithm = Column(Enum(AlgorithmType), nullable=True)
    __table_args__ = (
        CheckConstraint("status IN ('lobby','started','finished')", name="game_status_check"),
    )
