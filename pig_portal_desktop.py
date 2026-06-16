from __future__ import annotations

import argparse
import atexit
import base64
import configparser
import contextlib
import datetime as dt
import hmac
import json
import logging
import os
import pathlib
import secrets
import shutil
import socket
import sqlite3
import sys
import threading
import time
import uuid
import webbrowser
from typing import Any, Iterable

from flask import Flask, Response, abort, g, jsonify, request, send_from_directory

VALID_PROJECT_STATUSES = {"Active", "Inactive", "Completed"}
VALID_STEP_STATUSES = {"Not Started", "In Work", "C/W", ""}
WRITE_LOCK = threading.RLock()

DEFAULT_DATA: dict[str, dict[str, Any]] = {
    "MEST Days": {
        "status": "Active",
        "assignee": "Denison",
        "startDate": "2026-05-01",
        "totalTime": "5 Weeks",
        "etic": "2026-06-05",
        "steps": [
            {
                "issue": "MEST days management",
                "tool": "Use Envision to track red shirts",
                "etic": "5 Weeks",
                "status": "In Work",
            },
            {
                "issue": "Lack of funding for MEST days",
                "tool": "",
                "etic": "",
                "status": "C/W",
            },
            {
                "issue": "What to do if we can't get MEST days?",
                "tool": "Create a flowchart on Envision",
                "etic": "",
                "status": "In Work",
            },
        ],
    },
    "Supply Issues": {
        "status": "Inactive",
        "assignee": "Logistics Team",
        "startDate": "2026-05-10",
        "totalTime": "Ongoing",
        "etic": "TBD",
        "steps": [
            {
                "issue": "Inventory shortage analysis",
                "tool": "Audit current stock",
                "etic": "1 Week",
                "status": "In Work",
            }
        ],
    },
    "DSG Proficiency": {
        "status": "Completed",
        "assignee": "Training Dept",
        "startDate": "2026-05-15",
        "totalTime": "4 Weeks",
        "etic": "2026-06-12",
        "steps": [
            {
                "issue": "Review current proficiency metrics",
                "tool": "Data Pull",
                "etic": "2 Days",
                "status": "C/W",
            },
            {
                "issue": "Develop new training curriculum",
                "tool": "Drafting Tool",
                "etic": "2 Weeks",
                "status": "C/W",
            },
        ],
    },
}


def runtime_dir() -> pathlib.Path:
    """Directory beside the executable when frozen, otherwise beside this script."""
    if getattr(sys, "frozen", False):
        return pathlib.Path(sys.executable).resolve().parent
    return pathlib.Path(__file__).resolve().parent


def bundle_dir() -> pathlib.Path:
    """Directory containing bundled read-only files."""
    mei = getattr(sys, "_MEIPASS", None)
    if mei:
        return pathlib.Path(mei)
    return pathlib.Path(__file__).resolve().parent


APP_DIR = runtime_dir()
BUNDLE_DIR = bundle_dir()
STATIC_DIR = BUNDLE_DIR / "static"
CONFIG_PATH = APP_DIR / "pig_portal_config.ini"
DEFAULT_DATA_DIR = APP_DIR / "data"
DEFAULT_BACKUP_DIR = APP_DIR / "backups"
DEFAULT_DB_PATH = DEFAULT_DATA_DIR / "pig_portal.db"
LOG_PATH = APP_DIR / "pig_portal.log"


def setup_logging() -> None:
    try:
        APP_DIR.mkdir(parents=True, exist_ok=True)
        logging.basicConfig(
            filename=str(LOG_PATH),
            level=logging.INFO,
            format="%(asctime)s %(levelname)s %(message)s",
        )
    except Exception:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


setup_logging()


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat()


def clean_text(value: Any, max_len: int = 500) -> str:
    if value is None:
        return ""
    text = str(value).replace("\x00", "").strip()
    return text[:max_len]


def normalize_project_status(value: Any) -> str:
    status = clean_text(value, 40) or "Active"
    if status not in VALID_PROJECT_STATUSES:
        raise ValueError(f"Invalid project status: {status}")
    return status


def normalize_step_status(value: Any) -> str:
    status = clean_text(value, 40)
    if status == "":
        return "Not Started"
    if status not in VALID_STEP_STATUSES:
        raise ValueError(f"Invalid step status: {status}")
    return status


def create_default_config() -> None:
    if CONFIG_PATH.exists():
        return

    parser = configparser.ConfigParser()
    parser["database"] = {
        "path": str(DEFAULT_DB_PATH),
    }
    parser["app"] = {
        "host": "127.0.0.1",
        "port": "0",
        "auto_open_browser": "yes",
        "lock_timeout_seconds": "60",
        "stale_lock_minutes": "10",
        "backup_dir": str(DEFAULT_BACKUP_DIR),
        "password": "",
    }
    parser["security"] = {
        "frame_ancestors": "'self'",
    }
    with CONFIG_PATH.open("w", encoding="utf-8") as handle:
        parser.write(handle)


def load_config() -> configparser.ConfigParser:
    create_default_config()
    parser = configparser.ConfigParser()
    parser.read(CONFIG_PATH, encoding="utf-8")
    return parser


def _expand_config_path(value: str | None, fallback: pathlib.Path) -> pathlib.Path:
    raw = (value or "").strip()
    if not raw:
        return fallback
    expanded = os.path.expandvars(os.path.expanduser(raw))
    path = pathlib.Path(expanded)
    if not path.is_absolute():
        path = APP_DIR / path
    return path.resolve()


def get_db_path() -> pathlib.Path:
    env_path = os.environ.get("PIG_PORTAL_DB")
    if env_path:
        return _expand_config_path(env_path, DEFAULT_DB_PATH)
    config = load_config()
    return _expand_config_path(config.get("database", "path", fallback=str(DEFAULT_DB_PATH)), DEFAULT_DB_PATH)


def get_backup_dir() -> pathlib.Path:
    env_path = os.environ.get("PIG_PORTAL_BACKUP_DIR")
    if env_path:
        return _expand_config_path(env_path, DEFAULT_BACKUP_DIR)
    config = load_config()
    return _expand_config_path(config.get("app", "backup_dir", fallback=str(DEFAULT_BACKUP_DIR)), DEFAULT_BACKUP_DIR)


def get_app_password() -> str:
    env_password = os.environ.get("PIG_PORTAL_PASSWORD")
    if env_password is not None:
        return env_password
    config = load_config()
    return config.get("app", "password", fallback="")


def get_lock_timeout_seconds() -> float:
    config = load_config()
    try:
        return max(5.0, config.getfloat("app", "lock_timeout_seconds", fallback=60.0))
    except ValueError:
        return 60.0


def get_stale_lock_seconds() -> float:
    config = load_config()
    try:
        minutes = max(1.0, config.getfloat("app", "stale_lock_minutes", fallback=10.0))
    except ValueError:
        minutes = 10.0
    return minutes * 60.0


def safe_user() -> str:
    return os.environ.get("USERNAME") or os.environ.get("USER") or "unknown"


def safe_host() -> str:
    try:
        return socket.gethostname()
    except Exception:
        return "unknown"


class NetworkWriteLock:
    """
    Application-level write lock using atomic directory creation.

    This is intentionally separate from SQLite's own locks. It serializes writes from
    multiple copies of the EXE pointed at the same shared database path.
    """

    def __init__(self, db_path: pathlib.Path, timeout_seconds: float, stale_seconds: float) -> None:
        self.db_path = db_path
        self.lock_dir = pathlib.Path(str(db_path) + ".write.lock")
        self.owner_path = self.lock_dir / "owner.json"
        self.timeout_seconds = timeout_seconds
        self.stale_seconds = stale_seconds
        self.token = secrets.token_hex(16)
        self.acquired = False

    def __enter__(self) -> "NetworkWriteLock":
        self.acquire()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.release()

    def acquire(self) -> None:
        deadline = time.monotonic() + self.timeout_seconds
        last_owner = "unknown"
        while True:
            try:
                self.db_path.parent.mkdir(parents=True, exist_ok=True)
                os.mkdir(self.lock_dir)
                self._write_owner()
                self.acquired = True
                return
            except FileExistsError:
                last_owner = self.describe_owner()
                self._remove_if_stale()
            except OSError as error:
                logging.warning("Unable to acquire write lock: %s", error)
                last_owner = str(error)

            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"Database is busy. Another user may be saving changes. Lock owner: {last_owner}"
                )
            time.sleep(0.25)

    def _write_owner(self) -> None:
        owner = {
            "token": self.token,
            "pid": os.getpid(),
            "user": safe_user(),
            "host": safe_host(),
            "createdAt": utc_now(),
            "dbPath": str(self.db_path),
        }
        with self.owner_path.open("w", encoding="utf-8") as handle:
            json.dump(owner, handle, indent=2)

    def _read_owner(self) -> dict[str, Any]:
        try:
            with self.owner_path.open("r", encoding="utf-8") as handle:
                payload = json.load(handle)
            return payload if isinstance(payload, dict) else {}
        except Exception:
            return {}

    def describe_owner(self) -> str:
        owner = self._read_owner()
        if not owner:
            return str(self.lock_dir)
        return f"{owner.get('user', 'unknown')} on {owner.get('host', 'unknown')} at {owner.get('createdAt', 'unknown time')}"

    def _lock_age_seconds(self) -> float:
        try:
            path = self.owner_path if self.owner_path.exists() else self.lock_dir
            return max(0.0, time.time() - path.stat().st_mtime)
        except Exception:
            return 0.0

    def _remove_if_stale(self) -> None:
        if self._lock_age_seconds() < self.stale_seconds:
            return
        owner = self.describe_owner()
        logging.warning("Removing stale PIG Portal DB lock owned by %s", owner)
        try:
            shutil.rmtree(self.lock_dir)
        except FileNotFoundError:
            return
        except Exception as error:
            logging.warning("Failed to remove stale lock %s: %s", self.lock_dir, error)

    def release(self) -> None:
        if not self.acquired:
            return
        try:
            owner = self._read_owner()
            if owner.get("token") == self.token:
                shutil.rmtree(self.lock_dir)
        except FileNotFoundError:
            pass
        except Exception as error:
            logging.warning("Failed to release DB lock %s: %s", self.lock_dir, error)
        finally:
            self.acquired = False


def current_lock_status() -> dict[str, Any]:
    db_path = get_db_path()
    lock = NetworkWriteLock(db_path, timeout_seconds=0.1, stale_seconds=get_stale_lock_seconds())
    exists = lock.lock_dir.exists()
    return {
        "locked": exists,
        "lockPath": str(lock.lock_dir),
        "owner": lock.describe_owner() if exists else "",
    }


@contextlib.contextmanager
def app_write_lock() -> Iterable[None]:
    with WRITE_LOCK:
        lock = NetworkWriteLock(
            get_db_path(),
            timeout_seconds=get_lock_timeout_seconds(),
            stale_seconds=get_stale_lock_seconds(),
        )
        with lock:
            yield


def connect_db() -> sqlite3.Connection:
    db_path = get_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(
        db_path,
        timeout=max(30, int(get_lock_timeout_seconds())),
        detect_types=sqlite3.PARSE_DECLTYPES,
        isolation_level=None,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute(f"PRAGMA busy_timeout = {int(max(30, get_lock_timeout_seconds()) * 1000)}")
    conn.execute("PRAGMA journal_mode = DELETE")
    conn.execute("PRAGMA synchronous = FULL")
    conn.execute("PRAGMA locking_mode = NORMAL")
    return conn


def db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = connect_db()
    return g.db


@contextlib.contextmanager
def transaction() -> Iterable[sqlite3.Connection]:
    with app_write_lock():
        conn = db()
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
        except Exception:
            conn.execute("ROLLBACK")
            raise
        else:
            conn.execute("COMMIT")


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            status TEXT NOT NULL DEFAULT 'Active'
                CHECK (status IN ('Active', 'Inactive', 'Completed')),
            assignee TEXT NOT NULL DEFAULT '',
            start_date TEXT NOT NULL DEFAULT '',
            total_time TEXT NOT NULL DEFAULT '',
            etic TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS steps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            position INTEGER NOT NULL,
            issue TEXT NOT NULL DEFAULT '',
            tool TEXT NOT NULL DEFAULT '',
            etic TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'Not Started'
                CHECK (status IN ('Not Started', 'In Work', 'C/W')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_steps_project_position
            ON steps(project_id, position, id);
        """
    )


def seed_defaults_if_empty(conn: sqlite3.Connection) -> None:
    project_count = conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
    if project_count:
        return

    now = utc_now()
    for name, project in DEFAULT_DATA.items():
        cursor = conn.execute(
            """
            INSERT INTO projects
                (name, status, assignee, start_date, total_time, etic, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                name,
                normalize_project_status(project.get("status")),
                clean_text(project.get("assignee")),
                clean_text(project.get("startDate"), 100),
                clean_text(project.get("totalTime"), 100),
                clean_text(project.get("etic"), 100),
                now,
                now,
            ),
        )
        project_id = int(cursor.lastrowid)
        for index, step in enumerate(project.get("steps", []), start=1):
            conn.execute(
                """
                INSERT INTO steps
                    (project_id, position, issue, tool, etic, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    project_id,
                    index,
                    clean_text(step.get("issue"), 1000),
                    clean_text(step.get("tool"), 1000),
                    clean_text(step.get("etic"), 100),
                    normalize_step_status(step.get("status")),
                    now,
                    now,
                ),
            )


def ensure_database() -> None:
    with app_write_lock():
        with connect_db() as conn:
            init_schema(conn)
            conn.execute("BEGIN IMMEDIATE")
            try:
                seed_defaults_if_empty(conn)
            except Exception:
                conn.execute("ROLLBACK")
                raise
            else:
                conn.execute("COMMIT")


def row_to_project(row: sqlite3.Row, steps: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "status": row["status"],
        "assignee": row["assignee"],
        "startDate": row["start_date"],
        "totalTime": row["total_time"],
        "etic": row["etic"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "steps": steps or [],
    }


def row_to_step(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "projectId": row["project_id"],
        "position": row["position"],
        "issue": row["issue"],
        "tool": row["tool"],
        "etic": row["etic"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def get_projects_with_steps(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    project_rows = conn.execute("SELECT * FROM projects ORDER BY name COLLATE NOCASE").fetchall()
    step_rows = conn.execute("SELECT * FROM steps ORDER BY project_id, position, id").fetchall()

    steps_by_project: dict[int, list[dict[str, Any]]] = {}
    for row in step_rows:
        steps_by_project.setdefault(row["project_id"], []).append(row_to_step(row))

    return [row_to_project(row, steps_by_project.get(row["id"], [])) for row in project_rows]


def get_project_or_404(conn: sqlite3.Connection, project_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    if row is None:
        abort(404, description="Project not found.")
    return row


def get_step_or_404(conn: sqlite3.Connection, step_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM steps WHERE id = ?", (step_id,)).fetchone()
    if row is None:
        abort(404, description="Step not found.")
    return row


def require_json() -> dict[str, Any]:
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        abort(400, description="Request body must be JSON object.")
    return payload


def wants_auth() -> bool:
    return bool(get_app_password())


def authorized() -> bool:
    password = get_app_password()
    if not password:
        return True

    header = request.headers.get("Authorization", "")
    if not header.startswith("Basic "):
        return False

    try:
        decoded = base64.b64decode(header[6:], validate=True).decode("utf-8")
        _, supplied_password = decoded.split(":", 1)
    except Exception:
        return False

    return hmac.compare_digest(supplied_password, password)


def auth_challenge() -> Response:
    return Response(
        "Authentication required.",
        401,
        {"WWW-Authenticate": 'Basic realm="PIG Portal"'},
    )


def create_app() -> Flask:
    app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
    app.config["JSON_SORT_KEYS"] = False
    app.config["SECRET_KEY"] = os.environ.get("PIG_PORTAL_SECRET", secrets.token_hex(32))

    @app.before_request
    def check_auth() -> Response | None:
        if not authorized():
            return auth_challenge()
        return None

    @app.after_request
    def security_headers(response: Response) -> Response:
        config = load_config()
        frame_ancestors = os.environ.get(
            "PIG_PORTAL_FRAME_ANCESTORS",
            config.get("security", "frame_ancestors", fallback="'self'"),
        ).strip() or "'self'"
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        if frame_ancestors == "'self'":
            response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
            f"connect-src 'self'; frame-ancestors {frame_ancestors}; base-uri 'self'; form-action 'self'",
        )
        return response

    @app.teardown_appcontext
    def close_db(_: BaseException | None = None) -> None:
        conn = g.pop("db", None)
        if conn is not None:
            conn.close()

    @app.errorhandler(TimeoutError)
    def handle_timeout(error: TimeoutError) -> tuple[Response, int]:
        return jsonify({"error": str(error)}), 423

    @app.errorhandler(sqlite3.IntegrityError)
    def handle_integrity_error(error: sqlite3.IntegrityError) -> tuple[Response, int]:
        message = str(error)
        if "UNIQUE" in message.upper():
            return jsonify({"error": "A project with that name already exists."}), 409
        return jsonify({"error": "Database integrity error.", "detail": message}), 400

    @app.errorhandler(sqlite3.OperationalError)
    def handle_operational_error(error: sqlite3.OperationalError) -> tuple[Response, int]:
        message = str(error)
        if "locked" in message.lower() or "busy" in message.lower():
            return jsonify({"error": "Database is busy. Try again after the other user's save finishes.", "detail": message}), 423
        logging.exception("SQLite operational error")
        return jsonify({"error": "Database operation failed.", "detail": message}), 500

    @app.errorhandler(ValueError)
    def handle_value_error(error: ValueError) -> tuple[Response, int]:
        return jsonify({"error": str(error)}), 400

    @app.errorhandler(400)
    @app.errorhandler(404)
    @app.errorhandler(405)
    def handle_http_error(error: Any) -> tuple[Response, int]:
        description = getattr(error, "description", "Request failed.")
        code = getattr(error, "code", 500)
        return jsonify({"error": description}), code

    @app.get("/")
    def index() -> Response:
        return send_from_directory(STATIC_DIR, "index.html")

    @app.get("/api/health")
    def health() -> Response:
        return jsonify(
            {
                "ok": True,
                "mode": "desktop-local-server",
                "database": str(get_db_path()),
                "config": str(CONFIG_PATH),
                "backupDir": str(get_backup_dir()),
                "authEnabled": wants_auth(),
                "time": utc_now(),
                "lock": current_lock_status(),
            }
        )

    @app.get("/api/lock")
    def lock_status() -> Response:
        return jsonify(current_lock_status())

    @app.get("/api/projects")
    def list_projects() -> Response:
        return jsonify({"projects": get_projects_with_steps(db()), "time": utc_now()})

    @app.get("/api/projects/<int:project_id>")
    def get_project(project_id: int) -> Response:
        conn = db()
        row = get_project_or_404(conn, project_id)
        steps = [
            row_to_step(step)
            for step in conn.execute(
                "SELECT * FROM steps WHERE project_id = ? ORDER BY position, id",
                (project_id,),
            ).fetchall()
        ]
        return jsonify({"project": row_to_project(row, steps)})

    @app.post("/api/projects")
    def create_project() -> tuple[Response, int]:
        payload = require_json()
        name = clean_text(payload.get("name"), 150)
        if not name:
            abort(400, description="Project name is required.")

        now = utc_now()
        with transaction() as conn:
            cursor = conn.execute(
                """
                INSERT INTO projects
                    (name, status, assignee, start_date, total_time, etic, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    name,
                    normalize_project_status(payload.get("status", "Active")),
                    clean_text(payload.get("assignee")),
                    clean_text(payload.get("startDate"), 100),
                    clean_text(payload.get("totalTime"), 100),
                    clean_text(payload.get("etic"), 100),
                    now,
                    now,
                ),
            )
            project_id = int(cursor.lastrowid)
            row = get_project_or_404(conn, project_id)
        return jsonify({"project": row_to_project(row, [])}), 201

    @app.patch("/api/projects/<int:project_id>")
    def update_project(project_id: int) -> Response:
        payload = require_json()
        allowed_fields = {
            "name": ("name", lambda value: clean_text(value, 150)),
            "status": ("status", normalize_project_status),
            "assignee": ("assignee", clean_text),
            "startDate": ("start_date", lambda value: clean_text(value, 100)),
            "totalTime": ("total_time", lambda value: clean_text(value, 100)),
            "etic": ("etic", lambda value: clean_text(value, 100)),
        }

        assignments: list[str] = []
        values: list[Any] = []
        for key, (column, cleaner) in allowed_fields.items():
            if key in payload:
                cleaned = cleaner(payload[key])
                if key == "name" and not cleaned:
                    abort(400, description="Project name cannot be blank.")
                assignments.append(f"{column} = ?")
                values.append(cleaned)

        if not assignments:
            abort(400, description="No editable project fields were provided.")

        assignments.append("updated_at = ?")
        values.append(utc_now())
        values.append(project_id)

        with transaction() as conn:
            get_project_or_404(conn, project_id)
            conn.execute(f"UPDATE projects SET {', '.join(assignments)} WHERE id = ?", values)
            row = get_project_or_404(conn, project_id)
            steps = [
                row_to_step(step)
                for step in conn.execute(
                    "SELECT * FROM steps WHERE project_id = ? ORDER BY position, id",
                    (project_id,),
                ).fetchall()
            ]
        return jsonify({"project": row_to_project(row, steps)})

    @app.delete("/api/projects/<int:project_id>")
    def delete_project(project_id: int) -> Response:
        with transaction() as conn:
            get_project_or_404(conn, project_id)
            conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        return jsonify({"deleted": True, "projectId": project_id})

    @app.post("/api/projects/<int:project_id>/steps")
    def create_step(project_id: int) -> tuple[Response, int]:
        payload = require_json()
        now = utc_now()
        with transaction() as conn:
            get_project_or_404(conn, project_id)
            max_position = conn.execute(
                "SELECT COALESCE(MAX(position), 0) FROM steps WHERE project_id = ?",
                (project_id,),
            ).fetchone()[0]
            cursor = conn.execute(
                """
                INSERT INTO steps
                    (project_id, position, issue, tool, etic, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    project_id,
                    int(max_position) + 1,
                    clean_text(payload.get("issue"), 1000),
                    clean_text(payload.get("tool"), 1000),
                    clean_text(payload.get("etic"), 100),
                    normalize_step_status(payload.get("status", "Not Started")),
                    now,
                    now,
                ),
            )
            step = get_step_or_404(conn, int(cursor.lastrowid))
            conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, project_id))
        return jsonify({"step": row_to_step(step)}), 201

    @app.patch("/api/steps/<int:step_id>")
    def update_step(step_id: int) -> Response:
        payload = require_json()
        allowed_fields = {
            "position": ("position", lambda value: max(1, int(value))),
            "issue": ("issue", lambda value: clean_text(value, 1000)),
            "tool": ("tool", lambda value: clean_text(value, 1000)),
            "etic": ("etic", lambda value: clean_text(value, 100)),
            "status": ("status", normalize_step_status),
        }

        assignments: list[str] = []
        values: list[Any] = []
        for key, (column, cleaner) in allowed_fields.items():
            if key in payload:
                assignments.append(f"{column} = ?")
                values.append(cleaner(payload[key]))

        if not assignments:
            abort(400, description="No editable step fields were provided.")

        now = utc_now()
        assignments.append("updated_at = ?")
        values.append(now)
        values.append(step_id)

        with transaction() as conn:
            existing = get_step_or_404(conn, step_id)
            conn.execute(f"UPDATE steps SET {', '.join(assignments)} WHERE id = ?", values)
            step = get_step_or_404(conn, step_id)
            conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, existing["project_id"]))
        return jsonify({"step": row_to_step(step)})

    @app.delete("/api/steps/<int:step_id>")
    def delete_step(step_id: int) -> Response:
        with transaction() as conn:
            step = get_step_or_404(conn, step_id)
            project_id = int(step["project_id"])
            conn.execute("DELETE FROM steps WHERE id = ?", (step_id,))
            remaining = conn.execute(
                "SELECT id FROM steps WHERE project_id = ? ORDER BY position, id",
                (project_id,),
            ).fetchall()
            for index, row in enumerate(remaining, start=1):
                conn.execute("UPDATE steps SET position = ? WHERE id = ?", (index, row["id"]))
            conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (utc_now(), project_id))
        return jsonify({"deleted": True, "stepId": step_id})

    @app.post("/api/backups")
    def create_backup() -> Response:
        backup_dir = get_backup_dir()
        backup_dir.mkdir(parents=True, exist_ok=True)
        source = get_db_path()
        if not source.exists():
            abort(404, description="Database file does not exist yet.")

        timestamp = dt.datetime.now(dt.UTC).strftime("%Y%m%d_%H%M%S")
        backup_path = backup_dir / f"pig_portal_{timestamp}.db"
        with app_write_lock():
            source_conn = db()
            backup_conn = sqlite3.connect(backup_path)
            try:
                source_conn.backup(backup_conn)
            finally:
                backup_conn.close()

        return jsonify({"backup": str(backup_path), "createdAt": utc_now()})

    @app.get("/api/export")
    def export_json() -> Response:
        payload = {"exportedAt": utc_now(), "projects": get_projects_with_steps(db())}
        return jsonify(payload)

    return app


app = create_app()


def find_free_port(host: str) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def get_runtime_options(args: argparse.Namespace) -> tuple[str, int, bool]:
    config = load_config()
    host = args.host or os.environ.get("PIG_PORTAL_HOST") or config.get("app", "host", fallback="127.0.0.1")
    port_raw = args.port if args.port is not None else os.environ.get("PIG_PORTAL_PORT") or config.get("app", "port", fallback="0")
    try:
        port = int(port_raw)
    except (TypeError, ValueError):
        port = 0
    if port == 0:
        port = find_free_port(host)
    auto_open = not args.no_browser and config.getboolean("app", "auto_open_browser", fallback=True)
    return host, port, auto_open


def launch_browser(url: str) -> None:
    def _open() -> None:
        try:
            webbrowser.open(url, new=2)
        except Exception as error:
            logging.warning("Failed to open browser: %s", error)

    threading.Timer(0.8, _open).start()


def main() -> None:
    parser = argparse.ArgumentParser(description="Run PIG Portal as a local desktop web app.")
    parser.add_argument("--host", default=None, help="Local host/IP to bind. Default comes from config.")
    parser.add_argument("--port", type=int, default=None, help="Port to bind. Use 0 for automatic.")
    parser.add_argument("--db", default=None, help="Override shared database path.")
    parser.add_argument("--no-browser", action="store_true", help="Do not auto-open the browser.")
    parser.add_argument("--dev", action="store_true", help="Run Flask's development server instead of Waitress.")
    args = parser.parse_args()

    if args.db:
        os.environ["PIG_PORTAL_DB"] = args.db

    create_default_config()
    ensure_database()

    host, port, auto_open = get_runtime_options(args)
    url = f"http://{host}:{port}/"

    print("PIG Portal desktop app is running.")
    print(f"Open: {url}")
    print(f"Database: {get_db_path()}")
    print(f"Config: {CONFIG_PATH}")
    print(f"Log: {LOG_PATH}")

    if auto_open:
        launch_browser(url)

    if args.dev:
        app.run(host=host, port=port, debug=True)
        return

    try:
        from waitress import serve
    except ImportError as exc:
        raise SystemExit("Waitress is not installed. Run: pip install -r requirements.txt") from exc

    serve(app, host=host, port=port, threads=4)


atexit.register(logging.shutdown)


if __name__ == "__main__":
    main()
