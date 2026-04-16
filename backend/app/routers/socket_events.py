import asyncio
import datetime
import json
import random
import uuid
from functools import partial

from app.main import sio
from sqlalchemy import case, desc, func, text
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models.attempts import Attempt
from ..models.game import Game
from ..models.game_players import GamePlayers
from ..models.logs import Logs
from ..models.num_answer import NumAnswer
from ..models.questions import Question
from ..models.recommendations import Recommendation
from ..models.rounds import Round
from ..models.student_stats import StudentStats
from ..models.teacher_actions import TeacherAction
from ..models.users import User
from ..models.topics import Topic
from .ml_feedback import FeedbackRequest, derive_true_label, feedback_function
from .ml_predict import DifficultyRequest, predict_function
from .socket_auth import authenticate_socket_with_token
from ..models.recommendations import AlgorithmType

questions = {}


def get_topic_difficulty(student: User, topic: Topic) -> int:
    if topic is None or student is None:
        return 3

    if topic.name == "Brojevi do 100":
        return student.difficulty_do_sto
    if topic.name == "Množenje i dijeljenje":
        return student.difficulty_mnozenje
    if topic.name == "Zbrajanje i oduzimanje":
        return student.difficulty_zbrajanje

    return 3


def _utc_now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _parse_client_timestamp(ts) -> datetime.datetime:
    """
    Accepts:
      - ISO string with `Z` or `+00:00`
      - epoch ms (int/float)
    Returns timezone-aware UTC datetime.
    """
    if ts is None:
        return _utc_now()

    # epoch ms
    if isinstance(ts, (int, float)):
        return datetime.datetime.fromtimestamp(
            float(ts) / 1000.0, tz=datetime.timezone.utc
        )

    if isinstance(ts, str):
        s = ts.strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        try:
            dt = datetime.datetime.fromisoformat(s)
        except Exception:
            return _utc_now()
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        return dt.astimezone(datetime.timezone.utc)

    return _utc_now()


def _logs_columns(db: Session) -> set[str]:
    try:
        insp = sa_inspect(db.get_bind())
        cols = insp.get_columns("logs") or []
        return {str(c.get("name")) for c in cols if c.get("name")}
    except Exception:
        return set()


def _insert_log_row(
    db: Session, created_at: datetime.datetime, user_id_raw: str, log_text: str
) -> None:
    """ insert into logs table """
    cols = _logs_columns(db)

    has_created_at = "created_at" in cols
    # DB might use `student_id` (FK) instead of `user_id`.
    fk_col = (
        "student_id"
        if "student_id" in cols
        else ("user_id" if "user_id" in cols else None)
    )

    params: dict[str, object] = {"log": log_text}
    col_names: list[str] = []
    placeholders: list[str] = []

    if fk_col:
        col_names.append(fk_col)
        placeholders.append(f":{fk_col}")
        params[fk_col] = str(user_id_raw or "")

    if has_created_at:
        col_names.append("created_at")
        placeholders.append(":created_at")
        params["created_at"] = created_at

    col_names.append("log")
    placeholders.append(":log")

    db.execute(
        text(
            f"INSERT INTO logs ({', '.join(col_names)}) VALUES ({', '.join(placeholders)})"
        ),
        params,
    )


def _finish_game(db: Session, game: Game) -> None:
    """Mark game as finished and deactivate all active players."""
    game.status = "finished"
    game.end_time = datetime.datetime.utcnow()
    db.add(game)

    active_players = (
        db.query(GamePlayers)
        .filter(GamePlayers.game_id == game.id, GamePlayers.is_active.is_(True))
        .all()
    )
    for p in active_players:
        p.is_active = False
        p.left_at = datetime.datetime.utcnow()
        db.add(p)

    db.commit()


@sio.event
async def connect(sid, environ, auth):
    token = None

    # Get token from auth payload (Socket.IO client auth option)
    if auth and isinstance(auth, dict):
        token = auth.get("token")

    # Fallback: Authorization header
    if not token:
        token = environ.get("HTTP_AUTHORIZATION")
        # `authenticate_socket_with_token` will normalize Bearer prefix if present

    if not token or not str(token).strip():
        return False

    user = await authenticate_socket_with_token(str(token).strip())

    if not user:
        return False

    # Attach user to socket session
    await sio.save_session(
        sid,
        {
            "user_id": str(user.id),
            "role": user.role,
            "username": user.username,
        },
    )

    print("Socket connected:", user.username)


@sio.event
async def teacherJoin(sid, data):
    session = await sio.get_session(sid)

    if session["role"] != "teacher":
        await sio.emit("error", {"message": "Unauthorized"}, to=sid)
        return

    db = SessionLocal()
    try:
        # Accept joining both lobby and started games (teacher page needs to reconnect after start).
        # Parse ids defensively because socket session stores them as strings.
        teacher_id = uuid.UUID(str(session["user_id"]))
        game_id = uuid.UUID(str(data["game_id"]))

        game = (
            db.query(Game)
            .filter(
                Game.id == game_id,
                Game.teacher_id == teacher_id,
            )
            .first()
        )

        if not game:
            await sio.emit("error", {"message": "Invalid game"}, to=sid)
            return
        if game.status == "finished":
            await sio.emit("error", {"message": "Game already finished"}, to=sid)
            return

        await sio.enter_room(sid, str(game.id))
        # Store game_id for teacher so we can close the lobby if teacher disconnects.
        mode = None
        if isinstance(data, dict):
            mode = data.get("mode")
        await sio.save_session(sid, {**session, "game_id": str(game.id), "mode": mode})
        await emit_players(game.id)
    finally:
        db.close()


# student join
@sio.event
async def handle_join_game(sid, data):
    session = await sio.get_session(sid)

    if session["role"] != "student":
        await sio.emit("error", {"message": "Students only"}, to=sid)
        return

    db = SessionLocal()
    try:
        game = (
            db.query(Game)
            .filter(Game.game_code == data["game_code"], Game.status == "lobby")
            .first()
        )

        if not game:
            await sio.emit("error", {"message": "Game not found"}, to=sid)
            return

        user_id = session["user_id"]

        user = db.query(User).filter(User.id == user_id, User.role == "student").first()

        if not user:
            await sio.emit("error", {"message": "User not found"}, to=sid)
            return

        player = (
            db.query(GamePlayers).filter_by(game_id=game.id, user_id=user.id).first()
        )

        if player:
            player.socket_id = sid
            player.is_active = True
            player.left_at = None
        else:
            db.add(
                GamePlayers(
                    game_id=game.id,
                    user_id=user.id,
                    socket_id=sid,
                    is_active=True,
                    left_at=None,
                )
            )

        db.commit()

        # Store game_id on the socket session so we can cleanly handle disconnects
        await sio.save_session(
            sid,
            {
                **session,
                "game_id": str(game.id),
            },
        )

        await sio.enter_room(sid, str(game.id))
        await emit_players(game.id)

        # Ack to the joining student so the UI can stop "connecting" even if updatePlayers is delayed.
        await sio.emit("joinedGame", {"game_id": str(game.id)}, to=sid)
    finally:
        db.close()


@sio.event
async def joinGame(sid, data):
    """
    Frontend emits `joinGame`.
    Keep the existing implementation in `handle_join_game` and expose this wrapper
    so students don't get stuck in infinite "Povezivanje..." when the event name mismatches.
    """
    return await handle_join_game(sid, data)


async def emit_players(game_id):
    db = SessionLocal()
    try:
        rows = (
            db.query(
                User.id.label("user_id"),
                User.username.label("username"),
                #User.current_difficulty.label("level"), ***SALJU SE SVA TRI DIFFICULTYJA NEK FRONTEND FILTRIRA ***
                User.difficulty_do_sto.label("level_brojevi_do_sto"),
                User.difficulty_mnozenje.label("level_mnozenje_dijeljenje"),
                User.difficulty_zbrajanje.label("level_zbrajanje_oduzimanje"),
                StudentStats.xp.label("xp"),
            )
            .join(GamePlayers, GamePlayers.user_id == User.id)
            .outerjoin(StudentStats, StudentStats.user_id == User.id)
            .filter(GamePlayers.game_id == game_id, GamePlayers.is_active.is_(True))
            .all()
        )

        players_simple = [r.username for r in rows]

        user_ids = [r.user_id for r in rows if r.user_id]

        # Latest recommendation
        rec_map: dict[str, dict] = {}
        if user_ids:
            latest_recs = (
                db.query(
                    Recommendation.user_id.label("user_id"),
                    Recommendation.rec.label("rec"),
                    Recommendation.confidence.label("confidence"),
                )
                .outerjoin(Round, Round.id == Recommendation.round_id)
                .filter(Recommendation.user_id.in_(user_ids))
                .order_by(
                    Recommendation.user_id,
                    desc(Round.end_ts).nulls_last(),
                    desc(Recommendation.id),
                )
                .distinct(Recommendation.user_id)
                .all()
            )
            for r in latest_recs:
                rec_map[str(r.user_id)] = {
                    "last_recommendation": r.rec,
                    "recommendation_confidence": float(r.confidence) if r.confidence is not None else None,
                }


        # Last round performance per user
        perf_map: dict[str, dict] = {}

        if user_ids:
            last_rounds = (
                db.query(
                    Round.user_id.label("user_id"),
                    Round.accuracy,
                    Round.avg_time_secs,
                    Round.hints,
                    Recommendation.prev_difficulty,
                )
                .outerjoin(Recommendation, Recommendation.round_id == Round.id)
                .filter(Round.user_id.in_(user_ids))
                .order_by(
                    Round.user_id,
                    desc(Round.end_ts).nulls_last(),
                    desc(Round.id),
                )
                .distinct(Round.user_id)
                .all()
            )

            for r in last_rounds:
                prev = int(r.prev_difficulty) if r.prev_difficulty is not None else None

                perf_map[str(r.user_id)] = {
                    # 🔹 previous level po topicima (frontend filtrira)
                    "previous_level_brojevi_do_sto": prev,
                    "previous_level_mnozenje_dijeljenje": prev,
                    "previous_level_zbrajanje_oduzimanje": prev,

                    # 🔹 performance podaci
                    "accuracy": float(r.accuracy) if r.accuracy is not None else None,
                    "avg_time_secs": float(r.avg_time_secs) if r.avg_time_secs is not None else None,
                    "hints_used": int(r.hints) if r.hints is not None else 0,
                }



        # Rank players by XP (desc). If stats row doesn't exist, treat as 0.
        ranked = sorted(rows, key=lambda r: int(r.xp or 0), reverse=True)
        rank_by_user_id = {str(r.user_id): idx + 1 for idx, r in enumerate(ranked)}

        players_detailed = [
            {
                "user_id": str(r.user_id),
                "username": r.username,
                "level_brojevi_do_sto": int(r.level_brojevi_do_sto or 1),
                "level_mnozenje_dijeljenje": int(r.level_mnozenje_dijeljenje or 1),
                "level_zbrajanje_oduzimanje": int(r.level_zbrajanje_oduzimanje or 1),
                "xp": int(r.xp or 0),
                "rank": int(rank_by_user_id.get(str(r.user_id), 0) or 0),
                **(rec_map.get(str(r.user_id)) or {}),
                **(perf_map.get(str(r.user_id)) or {}),
            }
            for r in rows
        ]

        await sio.emit(
            "updatePlayers",
            {"players": players_simple, "playersDetailed": players_detailed},
            room=str(game_id),
        )
    finally:
        db.close()


@sio.event
async def disconnect(sid):
    db = SessionLocal()
    try:
        # IMPORTANT:
        # A teacher may "disconnect" simply by navigating from the lobby modal to the /teacher/game page,
        # which creates a new socket connection. Auto-closing the lobby here causes false "game finished"
        # and kicks students out. We only close games via explicit events (closeLobby/endGame).
        try:
            session = await sio.get_session(sid)
        except Exception:
            session = None
        if session and session.get("role") == "teacher":
            return

        # Prefer DB lookup by socket_id; fallback to session if needed
        player = (
            db.query(GamePlayers)
            .filter(GamePlayers.socket_id == sid, GamePlayers.is_active.is_(True))
            .first()
        )

        if not player:
            user_id = session.get("user_id") if session else None
            game_id = session.get("game_id") if session else None
            if not user_id or not game_id:
                return

            player = (
                db.query(GamePlayers)
                .filter(
                    GamePlayers.user_id == user_id,
                    GamePlayers.game_id == game_id,
                    GamePlayers.is_active.is_(True),
                )
                .first()
            )

            if not player:
                return

        player.is_active = False
        player.left_at = datetime.datetime.utcnow()
        db.commit()

        await emit_players(player.game_id)
    finally:
        db.close()


@sio.event
async def closeLobby(sid, data):
    """Teacher closes the lobby modal before/without playing. End game for all students."""
    session = await sio.get_session(sid)
    if not session or session.get("role") != "teacher":
        return

    game_id_raw = data.get("game_id") if isinstance(data, dict) else None
    if not game_id_raw:
        return

    db = SessionLocal()
    try:
        try:
            game_id = uuid.UUID(str(game_id_raw))
            teacher_id = uuid.UUID(str(session["user_id"]))
        except Exception:
            return

        game = (
            db.query(Game)
            .filter(Game.id == game_id, Game.teacher_id == teacher_id)
            .first()
        )
        if not game or game.status == "finished":
            return

        _finish_game(db, game)
        await sio.emit("gameClosed", {"game_id": str(game.id)}, room=str(game.id))
    finally:
        db.close()


@sio.event
async def endGame(sid, data):
    """Teacher ends an active game explicitly (from game page)."""
    session = await sio.get_session(sid)
    if not session or session.get("role") != "teacher":
        return

    game_id_raw = data.get("game_id") if isinstance(data, dict) else None
    if not game_id_raw:
        game_id_raw = session.get("game_id")
    if not game_id_raw:
        return

    db = SessionLocal()
    try:
        try:
            game_id = uuid.UUID(str(game_id_raw))
            teacher_id = uuid.UUID(str(session["user_id"]))
        except Exception:
            return

        game = (
            db.query(Game)
            .filter(Game.id == game_id, Game.teacher_id == teacher_id)
            .first()
        )
        if not game or game.status == "finished":
            return

        _finish_game(db, game)
        await sio.emit("gameClosed", {"game_id": str(game.id)}, room=str(game.id))
    finally:
        db.close()


async def get_socket_user(sid):
    session = await sio.get_session(sid)
    return session


@sio.event
async def startGame(sid, data):
    """Teacher starts the game and emits receiveQuestions (with round_id) to each student socket."""
    session = await sio.get_session(sid)
    if not session or session.get("role") != "teacher":
        await sio.emit("error", {"message": "Unauthorized"}, to=sid)
        return

    if not isinstance(data, dict):
        await sio.emit("error", {"message": "Invalid payload"}, to=sid)
        return

    game_id = data.get("game_id")
    topic_id = data.get("topic_id")
    if not game_id or not topic_id:
        await sio.emit("error", {"message": "Missing game_id or topic_id"}, to=sid)
        return

    db = SessionLocal()
    try:
        game = (
            db.query(Game)
            .filter(
                Game.id == game_id,
                Game.teacher_id == session["user_id"],
                Game.status == "lobby",
            )
            .first()
        )
        if not game:
            await sio.emit("error", {"message": "Game not found"}, to=sid)
            return
        game.status = "started"
        db.add(game)
        db.commit()

        room_key = str(game.id)
        if room_key not in questions:
            questions[room_key] = {}

        active = (
            db.query(GamePlayers)
            .filter(GamePlayers.game_id == game.id, GamePlayers.is_active.is_(True))
            .all()
        )

        for gp in active:
            if not gp.socket_id:
                continue

            student = (
                db.query(User)
                .filter(User.id == gp.user_id, User.role == "student")
                .first()
            )
            if not student:
                continue

            topic = db.query(Topic).filter(Topic.id == topic_id).first()
            user_questions = []
            topic_difficulty = get_topic_difficulty(student, topic)

            if topic is not None:
                if topic.name == "Brojevi do 100":
                    user_questions = generate_questions(db, topic_id, topic_difficulty, user_id=student.id, game_id=game.id)
                elif topic.name == "Množenje i dijeljenje":
                    user_questions = generate_questions(db, topic_id, topic_difficulty, user_id=student.id, game_id=game.id)
                elif topic.name == "Zbrajanje i oduzimanje":
                    user_questions = generate_questions(db, topic_id, topic_difficulty, user_id=student.id, game_id=game.id)

            round_obj = Round(
                user_id=student.id,
                game_id=game.id,
                topic_id=topic_id,
                topic_difficulty=topic_difficulty,
                question_count=len(user_questions),
                round_index=0,
            )
            db.add(round_obj)
            db.commit()
            db.refresh(round_obj)

            questions[room_key][gp.socket_id] = {
                "user_id": str(student.id),
                "question_ids": [q["question_id"] for q in user_questions],
                "round_id": str(round_obj.id),
            }

            await sio.emit(
                "receiveQuestions",
                {
                    "questions": user_questions,
                    "game_id": str(game.id),
                    "topic_id": str(topic_id),
                    "round_id": str(round_obj.id),
                },
                to=gp.socket_id,
            )

        await sio.emit("gameStarted", {"game_id": str(game.id)}, room=room_key)
    finally:
        db.close()


@sio.event
async def handle_start_game(sid, data):
    # Backwards compatible alias (if any old frontend emits this)
    await startGame(sid, data)


@sio.event
async def endGameLegacy(sid, data):
    """
    Legacy event kept for compatibility with any old clients.
    Prefer `endGame` + `gameClosed` for the current app.
    """
    return


DIFFICULTY_DISTRIBUTION = {
    1: {1: 10},
    2: {1: 2, 2: 6, 3: 2},
    3: {2: 2, 3: 6, 4: 2},
    4: {4: 8, 5: 2},
    5: {4: 4, 5: 6},
    6: {1: 10},
    7: {1: 2, 2: 6, 3: 2},
    8: {2: 2, 3: 6, 4: 2},
    9: {4: 8, 5: 2},
    10: {4: 4, 5: 6},
}


def generate_questions(db: Session, topic_id, current_difficulty: int, limit: int = 10, user_id=None, game_id=None):
    if not topic_id:
        return []

    distribution = DIFFICULTY_DISTRIBUTION.get(current_difficulty)
    if not distribution:
        return []

    # Get question IDs that the user has already answered in this game
    excluded_question_ids = set()
    if user_id and game_id:
        previous_attempts = (
            db.query(Attempt.question_id)
            .join(Round, Round.id == Attempt.round_id)
            .filter(
                Attempt.user_id == user_id,
                Round.game_id == game_id,
                Round.topic_id == topic_id  # Only exclude questions from the same topic
            )
            .all()
        )
        excluded_question_ids = {str(row.question_id) for row in previous_attempts}

    selected_questions = []
    # radi samo ako imamo dovoljno pitanja u bazi
    for difficulty, count in distribution.items():
        query = db.query(Question).filter(
            Question.topic_id == topic_id,
            Question.difficulty == difficulty,
        )
        
        # Exclude previously answered questions
        if excluded_question_ids:
            query = query.filter(Question.id.notin_(excluded_question_ids))
        
        rows = query.order_by(func.random()).limit(count).all()
        selected_questions.extend(rows)

    # promijesaj da tezine pitanja ne idu redom
    random.shuffle(selected_questions)

    result = []

    for q in selected_questions[:limit]:
        item = {
            "question_id": str(q.id),
            "question": q.text,
            "difficulty": q.difficulty,
            "type": q.type,
            "answer": {},
        }

        if q.type == "num":
            ans = db.query(NumAnswer).filter(NumAnswer.question_id == q.id).first()
            if ans:
                item["answer"] = {
                    "type": "numerical",
                    "correct_answer": ans.correct_answer,
                }

        """elif q.type == "mcq":
            ans = db.query(McAnswer).filter(McAnswer.question_id == q.id).first()
            if ans:
                item["answer"] = {
                    "type": "multiple_choice",
                    "option_a": ans.option_a,
                    "option_b": ans.option_b,
                    "option_c": ans.option_c,
                    "correct_answer": ans.correct_answer,
                }

        elif q.type == "wri":
            ans = db.query(WriAnswer).filter(WriAnswer.question_id == q.id).first()
            if ans:
                item["answer"] = {
                    "type": "written",
                    "correct_answer": ans.correct_answer,
                }"""

        result.append(item)

    return result


# FRONTEND SALJE:
# {
#  "round_id": "...",
#  "question_id": "...",
#  "is_correct": true,
#  "time_spent_secs": 8,
#  "hints_used": 1,
#  "num_attempts": 2
# }
# EVENT ZA HANDLEANJE SVAKOG ODGOVORA NA PITANJE
@sio.event
async def submit_answer(sid, data):
    db: Session = SessionLocal()
    try:
        session = await sio.get_session(sid)
        if not session:
            return

        user_id = session["user_id"]

        round_obj = db.query(Round).filter(Round.id == data["round_id"]).first()
        if not round_obj:
            await sio.emit("error", {"message": "Round not found"}, to=sid)
            return

        attempt = Attempt(
            user_id=user_id,
            question_id=data["question_id"],
            round_id=data["round_id"],
            topic_id=round_obj.topic_id,
            topic_difficulty=round_obj.topic_difficulty or 3,
            is_correct=data["is_correct"],
            num_attempts=data.get("num_attempts", 1),
            time_spent_secs=data.get("time_spent_secs", 0),
            hints_used=data.get("hints_used", 0),
        )

        db.add(attempt)
        db.commit()
    except Exception as e:
        db.rollback()
        await sio.emit("error", {"message": f"Database error {str(e)}"}, to=sid)
        return
    finally:
        db.close()


# dohvati novi batch pitanja
# frontend salje:
# topic_id = data["selectedTopic"]["topic_id"]
# room_id = data["room_id"]
@sio.event
async def fetch_new_batch(sid, data):
    db: Session = SessionLocal()
    try:
        session = await sio.get_session(sid)
        if not session:
            return

        user_id = session["user_id"]
        game_id = session.get("game_id")
        topic_id = data["selectedTopic"]["topic_id"]
        room_id = data["room_id"]

        student = db.query(User).filter((User.id == user_id)).first()
        if not student:
            await sio.emit("error", {"message": "User not found"}, to=sid)
            return

        topic = db.query(Topic).filter(Topic.id == topic_id).first()
        user_questions = []
        topic_difficulty = get_topic_difficulty(student, topic)
            
        if topic is not None:
            if topic.name == "Brojevi do 100":
                user_questions = generate_questions(db, topic_id, topic_difficulty, user_id=user_id, game_id=game_id)
            elif topic.name == "Množenje i dijeljenje":
                user_questions = generate_questions(db, topic_id, topic_difficulty, user_id=user_id, game_id=game_id)
            elif topic.name == "Zbrajanje i oduzimanje":
                user_questions = generate_questions(db, topic_id, topic_difficulty, user_id=user_id, game_id=game_id)
        

        last_round = (
            db.query(Round)
            .filter(Round.user_id == user_id, Round.game_id == game_id)
            .order_by(Round.round_index.desc())
            .first()
        )
        next_index = 0 if last_round is None else last_round.round_index + 1

        # Create round
        round_obj = Round(
            user_id=user_id,
            game_id=game_id,
            topic_id=topic_id,
            topic_difficulty=topic_difficulty,
            question_count=len(user_questions),
            round_index=next_index,
        )

        db.add(round_obj)
        db.commit()
        db.refresh(round_obj)

        if room_id not in questions:
            questions[room_id] = {}

        questions[room_id][sid] = {
            "user_id": str(user_id),
            "question_ids": [q["question_id"] for q in user_questions],
            "round_id": str(round_obj.id),
        }

        await sio.emit(
            "receiveQuestions",
            {
                "questions": user_questions,
                "game_id": str(game_id),
                "topic_id": str(topic_id),
                "round_id": str(round_obj.id),
            },
            to=sid,
        )
    except Exception as e:
        db.rollback()
        await sio.emit("error", {"message": f"Database error {str(e)}"}, to=sid)
        return
    finally:
        db.close()


# EVENT ZA GOTOVU RUNDU SVAKOG UCENIKA
#*** OVDJE JE U DATA DODAN I TOPIC_ID ***
@sio.event
async def finish_round(sid, data):
    db = SessionLocal()
    try:
        session = await sio.get_session(sid)
        if not session:
            return

        user_id = session["user_id"]
        topic_id = data["selectedTopic"]["topic_id"]
        try:
            await finalize_round(db, data["round_id"], user_id, data["xp"], topic_id)
        except Exception as e:
            await sio.emit("finishRoundError", {"message": str(e)}, to=sid)
            return

        game_id = session.get("game_id")
        if game_id:
            try:
                await emit_players(uuid.UUID(str(game_id)))
            except Exception:
                await emit_players(game_id)
    finally:
        db.close()


async def finalize_round(db: Session, round_id, user_id, xp, topic_id ):
    student = db.query(User).filter((User.id == user_id)).first()

    topic = db.query(Topic).filter(Topic.id == topic_id).first()

    round_obj = db.query(Round).filter(Round.id == round_id).one()
    if round_obj.topic_id is None:
        round_obj.topic_id = topic_id
    if round_obj.topic_difficulty is None:
        round_obj.topic_difficulty = get_topic_difficulty(student, topic)

    topic_difficulty = round_obj.topic_difficulty or 3

    stats = (
        db.query(
            func.count(Attempt.id),
            func.avg(Attempt.time_spent_secs),
            func.sum(Attempt.hints_used),
            #func.avg(1.0 / Attempt.num_attempts),
            func.avg(case((Attempt.num_attempts == 1, 1),else_=0),)

        )
        .filter(Attempt.round_id == round_id)
        .one()
    )

    total, avg_time, hints, accuracy = stats

    round_obj.end_ts = func.now()
    round_obj.avg_time_secs = avg_time or 0
    round_obj.hints = hints
    round_obj.accuracy = accuracy or 0

    db.add(round_obj)
    db.commit()
    db.refresh(round_obj)

    # call model
    from .algorithm_router import _active_algorithm
    from .ml_predict import DifficultyResponse

    accuracy_val = float(round_obj.accuracy or 0)
    avg_time_val = float(round_obj.avg_time_secs or 0)
    hints_val = int(round_obj.hints or 0)

    if _active_algorithm == "decision_tree":
        print("\n\ndecision tree\n\n")
        from ..services.decision_tree_service import predict_decision_tree
        result = predict_decision_tree(accuracy_val, avg_time_val, hints_val)
        label = result["next_difficulty"]
        diff_response = DifficultyResponse(label=label, probabilities={label: result.get("confidence", 1.0)})

    elif _active_algorithm == "ebm":
        print("\n\nebm\n\n")
        from ..services.ebm_service import predict_ebm
        result = predict_ebm(accuracy_val, avg_time_val, hints_val)
        label = result["next_difficulty"]
        diff_response = DifficultyResponse(label=label, probabilities={label: result.get("confidence", 1.0)})

    else:
        print("\n\nlogreg\n\n")
        diff_response = predict_function(
            DifficultyRequest(
                accuracy=accuracy_val,
                avg_time=avg_time_val,
                hints_used=hints_val,
            )
        )

    prev_round = (
        db.query(Round)
        .filter(
            Round.user_id == user_id,
            Round.round_index == round_obj.round_index - 1,
            Round.game_id == round_obj.game_id
        )
        .one_or_none()
    )

    if prev_round:
        prev_rec = (
            db.query(Recommendation)
            .filter(
                Recommendation.round_id == prev_round.id,
                Recommendation.true_label.is_(None),
            )
            .one_or_none()
        )

        if prev_rec:
            true_label = derive_true_label(prev_round, round_obj)

            prev_rec.true_label = true_label
            prev_rec.labeled_at = datetime.datetime.now()
            db.add(prev_rec)
            db.commit()

            try:
                loop = asyncio.get_event_loop()

                feedback_req = FeedbackRequest(
                    accuracy=prev_round.accuracy,
                    avg_time=prev_round.avg_time_secs,
                    hints_used=prev_round.hints,
                    true_label=true_label,
                    sample_weight=(5.0 * float(prev_rec.confidence)),
                )

                await loop.run_in_executor(
                    None,
                    partial(feedback_function, feedback_req)              
                )
            except Exception as e:
                print(f"FEEDBACK ERROR: {str(e)}")
                import traceback
                traceback.print_exc()

    # Defaults to avoid unbound new_diff/rec_text at edges
    new_diff = topic_difficulty
    rec_text = "same"

    if diff_response.label == 0:
        rec_text = "down"
        if topic_difficulty > 1:
            new_diff = topic_difficulty - 1
    elif diff_response.label == 1:
        rec_text = "same"
        new_diff = topic_difficulty
    elif diff_response.label == 2:
        rec_text = "up"
        if topic_difficulty < 5:
            new_diff = topic_difficulty + 1

    # create new recommendation based on model prediction and apply it instantly
    recommendation = Recommendation(
        round_id=round_id,
        user_id=user_id,
        rec=rec_text,
        confidence=diff_response.probabilities.get(diff_response.label, 1),
        prev_difficulty=topic_difficulty,
        new_difficulty=new_diff,
        round_index=round_obj.round_index,
        algorithm=AlgorithmType(_active_algorithm),
    )
    db.add(recommendation)

    #value teacher override over model recommendation
    #1. fetch newest teacher action for student 
    teacher_override = db.query(TeacherAction).filter(TeacherAction.user_id == student.id).order_by(TeacherAction.created_at.desc()).first()

    #2. check if teacher override was created during last students round
    #returns true if teacher action was created during the last round or ongoing round
    is_override_in_round = (
        teacher_override is not None
        and teacher_override.created_at >= round_obj.start_ts
        and (round_obj.end_ts is None or teacher_override.created_at <= round_obj.end_ts)
    )

    #3. if no override in round apply model recommendation
    if not is_override_in_round:
        topic_difficulty = new_diff

    if topic.name == "Brojevi do 100":
        student.difficulty_do_sto = topic_difficulty
    elif (topic.name == "Množenje i dijeljenje"):
        student.difficulty_mnozenje = topic_difficulty
    elif (topic.name == "Zbrajanje i oduzimanje"):
        student.difficulty_zbrajanje = topic_difficulty
         
    #apply
    db.add(student)
    db.commit()

    # student stats
    round_attempts = round_obj.question_count
    round_accuracy = float(round_obj.accuracy)

    stats = (
        db.query(StudentStats)
        .filter(StudentStats.user_id == round_obj.user_id)
        .one_or_none()
    )

    if not stats:
        stats = StudentStats(
            user_id=round_obj.user_id,
            total_attempts=0,
            overall_accuracy=0,
            xp=0,
        )
        db.add(stats)

    old_attempts = stats.total_attempts
    old_accuracy = float(stats.overall_accuracy or 0)

    new_attempts = old_attempts + round_attempts

    # weighted average accuracy
    new_accuracy = (
        (old_accuracy * old_attempts) + (round_accuracy * round_attempts)
    ) / new_attempts

    xp_gained = xp

    stats.total_attempts = new_attempts
    stats.overall_accuracy = new_accuracy
    stats.xp = xp_gained

    db.add(stats)
    db.commit()


# BACKUP PLAN -> bad database performance
@sio.event
async def log(sid, data):
    db = SessionLocal()
    try:
        session = await sio.get_session(sid)
        if not session:
            return

        user_id = str(session.get("user_id") or "")
        timestamp = data.get("timestamp") if isinstance(data, dict) else None
        created_at = _parse_client_timestamp(timestamp)

        # Allow either `text` (string) or a dict payload; store JSON string.
        if isinstance(data, dict) and "text" in data:
            log_text = str(data.get("text") or "")
        else:
            log_text = json.dumps(
                data, ensure_ascii=False, separators=(",", ":"), default=str
            )

        # Ensure user_id is always present in the stored JSON for later analysis.
        try:
            parsed = json.loads(log_text)
            if isinstance(parsed, dict):
                parsed.setdefault("user_id", user_id)
                parsed.setdefault("server_ts_iso", _utc_now().isoformat())
                log_text = json.dumps(
                    parsed, ensure_ascii=False, separators=(",", ":"), default=str
                )
        except Exception:
            pass

        _insert_log_row(
            db, created_at=created_at, user_id_raw=user_id, log_text=log_text
        )
        db.commit()

    except Exception as e:
        db.rollback()
        try:
            print(f"[logs] log failed: {e}")
        except Exception:
            pass
        return

    finally:
        db.close()


log_queue = asyncio.Queue()


# TO BE USED -> commits to database in batches
@sio.event
async def log_batched(sid, data):
    session = await sio.get_session(sid)
    if not session:
        return

    # Keep event for future batching, but make it safe with timestamps.
    timestamp = data.get("timestamp") if isinstance(data, dict) else None
    created_at = _parse_client_timestamp(timestamp)
    text_value = data.get("text") if isinstance(data, dict) else None
    await log_queue.put(
        {
            "user_id": str(session.get("user_id") or ""),
            "timestamp": created_at,
            "text": str(text_value or ""),
        }
    )


async def log_writer():
    while True:
        batch = []

        # wait for at least one
        item = await log_queue.get()
        batch.append(item)

        # grab more for 100ms
        try:
            while True:
                batch.append(await asyncio.wait_for(log_queue.get(), 0.1))
        except asyncio.TimeoutError:
            pass

        db = SessionLocal()
        try:
            for log in batch:
                db.add(
                    Logs(
                        user_id=log["user_id"],
                        created_at=log["timestamp"],  # POTENTIAL ISSUE
                        log=log["text"],
                    )
                )
            db.commit()
        except Exception as e:
            try:
                print(f"[logs] Could not commit batch to the database: {e}")
            except Exception:
                pass
        finally:
            db.close()
