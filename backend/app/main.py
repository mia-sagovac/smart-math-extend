import socketio
from fastapi import FastAPI
import os
from fastapi.middleware.cors import CORSMiddleware

from .routers import health, ml_feedback, ml_predict, test_db
from .routers.auth import router as auth
from .routers.classroom_router import router as classroom_router
from .routers.game_router import router as game_router
from .routers.topics_router import router as topics_router
from .routers.stats_router import router as stats_router
from .routers.override_router import router as override_router
from .routers.algorithm_router import router as algorithm_router
#from .routers.socket_events import log_writer
import asyncio

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://smart-math-phi.vercel.app",
    ],
)

fastapi_app = FastAPI(title="SmartMath API", version="0.1.0")

fastapi_app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://smart-math-phi.vercel.app",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type"],
)

app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)

# Routeri
fastapi_app.include_router(health.router, prefix="/health", tags=["health"])
fastapi_app.include_router(test_db.router, prefix="/test", tags=["test"])
fastapi_app.include_router(
    ml_predict.router, prefix="/difficulty", tags=["ML Model - predict difficulty"]
)
fastapi_app.include_router(
    ml_feedback.router,
    prefix="/difficulty",
    tags=["ML Model - get feedback and update model"],
)
fastapi_app.include_router(auth)
fastapi_app.include_router(classroom_router)
fastapi_app.include_router(game_router)
fastapi_app.include_router(topics_router)
fastapi_app.include_router(stats_router)
fastapi_app.include_router(override_router)
fastapi_app.include_router(algorithm_router)


@fastapi_app.get("/")
def root():
    return "Backend is running!"

from .routers import socket_events  # noqa: E402, F401

#start background writer to save logs
@fastapi_app.on_event("startup")
async def start_background_tasks():
    asyncio.create_task(socket_events.log_writer())

