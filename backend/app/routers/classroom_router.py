import random
from typing import Annotated, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models.classroom import Classroom
from ..models.student_stats import StudentStats
from ..models.user_classroom import user_classroom
from ..models.users import User
from ..routers.auth import get_current_user

router = APIRouter(prefix="/classroom", tags=["classroom"])
db_dependency = Annotated[Session, Depends(get_db)]


class CreateClassroomRequest(BaseModel):
    classroom_name: str


class AddStudentsReqest(BaseModel):
    classroom_name: str
    student_list: List[str]


class StudentOut(BaseModel):
    id: str
    username: str
    level: int


def generateClasroomCode():
    letters = "ABCDE"

    code = "".join(random.choice(letters) for _ in range(3))
    return code


@router.post("/create", summary="Create new classroom")
def create_new_classroom(
    request: CreateClassroomRequest,
    db: db_dependency,
    current_user: User = Depends(get_current_user),
):
    if current_user.role != "teacher":
        raise HTTPException(
            status_code=403,
            detail="User does not have permission to create classrooms.",
        )

    invalid_class_code = True
    new_class_code = None
    while invalid_class_code:
        new_class_code = generateClasroomCode()
        existing = (
            db.query(Classroom).filter(Classroom.class_code == new_class_code).first()
        )  # vec postoji classroom sa tim kodom
        if existing is None:
            invalid_class_code = False
    print(new_class_code)
    new_classroom = Classroom(
        class_code=new_class_code,
        class_name=request.classroom_name,
        teacher_id=current_user.id,
    )

    db.add(new_classroom)
    db.commit()
    db.refresh(new_classroom)

    # add teacher to many to many relationship
    query = user_classroom.insert().values(
        user_id=current_user.id, class_id=new_classroom.id
    )

    db.execute(query)
    db.commit()

    return {"message": "Classroom created", "classroom_code": new_classroom.class_code}


@router.get("/my-classrooms", summary="Get all classrooms for current teacher")
def get_my_classrooms(
    db: db_dependency, current_user: User = Depends(get_current_user)
):
    if current_user.role != "teacher":
        raise HTTPException(
            status_code=403, detail="Only teachers can view their classrooms."
        )

    classrooms = (
        db.query(Classroom).filter(Classroom.teacher_id == current_user.id).all()
    )

    result = []
    for classroom in classrooms:
        # Count students in classroom
        student_count = (
            db.query(user_classroom)
            .filter(
                user_classroom.c.class_id == classroom.id,
                user_classroom.c.user_id != current_user.id,
            )
            .count()
        )

        result.append(
            {
                "id": str(classroom.id),
                "class_name": classroom.class_name,
                "class_code": classroom.class_code,
                "student_count": student_count,
            }
        )

    return result


@router.post("/add-students", summary="adds students to already existing classroom")
def addStudents(
    request: AddStudentsReqest,
    db: db_dependency,
    current_user: User = Depends(get_current_user),
):
    if current_user.role != "teacher":
        raise HTTPException(
            status_code=403, detail="User does not have permission to edit classrooms."
        )

    classroom = (
        db.query(Classroom)
        .filter(
            (Classroom.class_name == request.classroom_name),
            (Classroom.teacher_id == current_user.id),
        )
        .first()
    )

    students = db.query(User).filter(User.username.in_(request.student_list)).all()

    existing_user_ids = {
        row.user_id
        for row in db.execute(
            user_classroom.select().where(
                user_classroom.c.class_id == classroom.id,
                user_classroom.c.user_id.in_(
                    [s.id for s in students]
                ),  # uzima id svakog studenta u listi studenata
            )
        )
    }

    new_students = [
        s
        for s in students  # uzima studenta iz dobivene liste studenata
        if s.id not in existing_user_ids  # AKO oni vec nisu u razredu
    ]

    rows = [
        {"user_id": student.id, "class_id": classroom.id} for student in new_students
    ]

    db.execute(user_classroom.insert(), rows)
    db.commit()

    return {"message": "Students added"}


@router.get(
    "/unassigned-students",
    summary="Get all students that are not assigned to any classroom",
)
def get_unassigned_students(
    db: db_dependency,
    current_user: User = Depends(get_current_user),
):
    if current_user.role != "teacher":
        raise HTTPException(status_code=403, detail="Only teachers can view students.")

    # Students that are not in any classroom yet
    subq = select(user_classroom.c.user_id)

    students = (
        db.query(User)
        .filter(
            User.role == "student",
            ~User.id.in_(subq),
        )
        .order_by(User.username.asc())
        .all()
    )

    return [{"id": str(s.id), "username": s.username} for s in students]


@router.delete(
    "/{classroom_id}/students/{student_id}",
    summary="Remove a student from a classroom (teacher only) and unassign them from all classrooms",
)
def remove_student_from_classroom(
    classroom_id: str,
    student_id: str,
    db: db_dependency,
    current_user: User = Depends(get_current_user),
):
    if current_user.role != "teacher":
        raise HTTPException(
            status_code=403, detail="Only teachers can remove students."
        )

    classroom = (
        db.query(Classroom)
        .filter(Classroom.id == classroom_id, Classroom.teacher_id == current_user.id)
        .first()
    )
    if not classroom:
        raise HTTPException(status_code=404, detail="No such classroom.")

    student = (
        db.query(User).filter(User.id == student_id, User.role == "student").first()
    )
    if not student:
        raise HTTPException(status_code=404, detail="No such student.")

    # Must be in this teacher's classroom
    membership_exists = (
        db.execute(
            user_classroom.select().where(
                user_classroom.c.class_id == classroom.id,
                user_classroom.c.user_id == student.id,
            )
        ).first()
        is not None
    )
    if not membership_exists:
        raise HTTPException(status_code=404, detail="Student is not in this classroom.")

    db.execute(user_classroom.delete().where(user_classroom.c.user_id == student.id))
    db.commit()

    return {"message": "Student removed", "student_id": str(student.id)}


@router.get(
    "/classroom-students/<string:classroom_name>",
    summary="Get all students that are assigned to classroom",
)
def get_classroom_students(
    classroom_name,
    db: db_dependency,
    current_user: User = Depends(get_current_user),
):
    if current_user.role != "teacher":
        raise HTTPException(status_code=403, detail="Only teachers can view students.")
    
    classroom = (
        db.query(Classroom).filter((Classroom.class_name == classroom_name)).first()
    )
    if not classroom:
        raise HTTPException(status_code=404, detail="No such classroom.")
    
    #check if this is classroom teacher
    if classroom.teacher_id != current_user.id:
        raise HTTPException(status_code=403, detail="You are not teacher of this classroom.")
    
    students = (
        db.query(User, StudentStats)
        .join(
            user_classroom,
            user_classroom.c.user_id == User.id
        )
        .outerjoin(   # OUTER JOIN da dobijemo i one bez stats
            StudentStats,
            StudentStats.user_id == User.id
        )
        .filter(
            user_classroom.c.class_id == classroom.id,
            User.role == "student",
        )
        .order_by(User.username.asc())
        .all()
    )
    return [
        {
            "id": str(s.id),
            "username": s.username,
            "level": int(s.current_difficulty),
            "xp": int(stats.xp) if stats and stats.xp is not None else 0,
            "difficulty_do_sto": int(s.difficulty_do_sto),
            "difficulty_zbrajanje": int(s.difficulty_zbrajanje),
            "difficulty_mnozenje": int(s.difficulty_mnozenje),
        }
        for s, stats in students
    ]


from sqlalchemy.orm import aliased
from sqlalchemy import desc

@router.get(
    "/{classroom_id}/students",
    summary="Get all students in a classroom (teacher only, by classroom_id)",
)
def get_students_in_classroom_by_id(
    classroom_id: str,
    db: db_dependency,
    current_user: User = Depends(get_current_user),
):
    if current_user.role != "teacher":
        raise HTTPException(status_code=403, detail="Only teachers can view students.")

    classroom = (
        db.query(Classroom)
        .filter(
            Classroom.id == classroom_id,
            Classroom.teacher_id == current_user.id
        )
        .first()
    )
    if not classroom:
        raise HTTPException(status_code=404, detail="No such classroom.")

    students = (
        db.query(User, StudentStats)
        .join(
            user_classroom,
            user_classroom.c.user_id == User.id
        )
        .outerjoin(   # OUTER JOIN da dobijemo i one bez stats
            StudentStats,
            StudentStats.user_id == User.id
        )
        .filter(
            user_classroom.c.class_id == classroom.id,
            User.role == "student"
        )
        .order_by(User.username.asc())
        .all()
    )

    return [
        {
            "id": str(user.id),
            "username": user.username,
            "level": int(user.current_difficulty),
            "xp": int(stats.xp) if stats and stats.xp is not None else 0,
            "difficulty_do_sto": int(user.difficulty_do_sto if user.difficulty_do_sto is not None else 3),
            "difficulty_zbrajanje": int(user.difficulty_zbrajanje if user.difficulty_zbrajanje is not None else 3),
            "difficulty_mnozenje": int(user.difficulty_mnozenje if user.difficulty_mnozenje is not None else 3),
        }
        for user, stats in students
    ]

