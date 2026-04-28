from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
from .config import settings

engine = create_engine(
    settings.DATABASE_URL,
    pool_size=30,
    max_overflow=40,
    pool_timeout=40
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# Dependency za FastAPI
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
