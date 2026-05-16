"""Hearth Python backend entrypoint (FastAPI on port 5003)."""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import agent_routes, customer_routes, install_route, onboard_route, spec_routes
from .db import create_pool
from .email_ import Mailer, MailerConfig
from .env import load_env
from .schema import ensure_schema

logger = logging.getLogger("hearth_python")


def create_app() -> FastAPI:
    env = load_env()
    pool = create_pool(env.database_url)
    ensure_schema(pool)

    mailer = Mailer(MailerConfig(
        host=env.smtp_host,
        port=env.smtp_port,
        from_addr=env.smtp_from,
        public_base_url=env.hearth_public_base_url,
    ))

    app = FastAPI(title="hearth-python", version="0.0.0")
    # Pool stashed on app.state so per-request Depends(get_pool) can fish it
    # out. Stores are constructed per-request from a freshly-acquired conn
    # (see stores.py); the Python SDK doesn't accept a Pool directly.
    app.state.pool = pool

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["*"],
        allow_credentials=False,
    )

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(spec_routes.build_router())
    app.include_router(install_route.build_router(pool=pool), prefix="/app")
    app.include_router(onboard_route.build_router(pool=pool), prefix="/app")
    app.include_router(customer_routes.build_router(mailer=mailer), prefix="/app")
    app.include_router(agent_routes.build_router(mailer=mailer), prefix="/app")

    @app.exception_handler(StarletteHTTPException)
    async def http_exc_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        if isinstance(exc.detail, dict):
            return JSONResponse(status_code=exc.status_code, content=exc.detail)
        return JSONResponse(status_code=exc.status_code, content={"error": {"code": "error", "message": str(exc.detail)}})

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={"error": {"code": "invalid_request", "message": "validation failed", "details": exc.errors()}},
        )

    return app


app = create_app()


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    env = load_env()
    uvicorn.run("hearth_python.main:app", host="0.0.0.0", port=env.port, reload=False)
