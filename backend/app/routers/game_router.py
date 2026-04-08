import datetime
import logging
import random
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import get_db
from ..models.game import Game
from ..models.users import User
from ..routers.auth import get_current_user

router = APIRouter(prefix="/game", tags=["game"])
db_dependency = Annotated[Session, Depends(get_db)]
logger = logging.getLogger(__name__)


def generateGameCode():
    letters = "ABCDE"

    code = "".join(random.choice(letters) for _ in range(3))
    return code


@router.post("/create-multiplayer-game")
def create_multiplayer_game(
    db: db_dependency, current_user: User = Depends(get_current_user)
):
    # game_code is UNIQUE and the space is small (ABCD^4 = 256), so collisions are expected.
    for _ in range(30):
        game = Game(
            game_code=generateGameCode(),
            teacher_id=current_user.id,
            status="lobby",
            created_at=datetime.datetime.utcnow(),
        )

        try:
            db.add(game)
            db.commit()
            db.refresh(game)
            return {
                "game_id": str(game.id),
                "game_code": game.game_code,
            }
        except IntegrityError:
            db.rollback()
            continue
        except Exception:
            db.rollback()
            logger.exception("Database error while creating multiplayer game")
            raise HTTPException(500, "Database error")

    raise HTTPException(409, "Could not generate a unique game code. Try again.")


# TODO: lockroom
@router.post("/lock-room/<string:game_id>")
def lock_room(game_id, db: db_dependency):
    game = db.query(Game).filter((Game.game_id == game_id)).first()

    if not game:
        return {"message": "No such game in database"}, 404

    try:
        game.status = "finished"
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        return {"message": f"Database error: {str(e)}"}, 500

    return {"game_id": str(game.game_id), "message": "Game finished"}, 200
