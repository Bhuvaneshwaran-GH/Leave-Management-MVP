import os
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Set

import bcrypt
import jwt
import psycopg
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr
from psycopg.rows import dict_row

load_dotenv(Path(__file__).with_name(".env"))
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://sekurzen_app:your-password@localhost:5432/sekurzen")
JWT_SECRET = os.getenv("JWT_SECRET", "change-this-secret")
app = FastAPI(title="SEKURZEN Leave API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
bearer = HTTPBearer()


def db():
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)


@app.on_event("startup")
def ensure_notification_storage():
    with db() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS organization_holidays (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                holiday_date date NOT NULL,
                name text NOT NULL CHECK (length(trim(name)) > 0),
                created_by uuid REFERENCES users(id) ON DELETE SET NULL,
                created_at timestamptz NOT NULL DEFAULT now(),
                UNIQUE (organization_id, holiday_date)
            )
            """
        )
        connection.execute("CREATE INDEX IF NOT EXISTS organization_holidays_org_date_idx ON organization_holidays(organization_id, holiday_date)")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS notifications (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                request_id uuid REFERENCES leave_requests(id) ON DELETE CASCADE,
                type text NOT NULL CHECK (type IN ('submitted', 'approved', 'rejected', 'cancelled')),
                message text NOT NULL,
                read_at timestamptz,
                created_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON notifications(recipient_id, created_at DESC)"
        )
        connection.execute(
            """
            DELETE FROM notifications older
            USING notifications newer
            WHERE older.id <> newer.id
              AND older.recipient_id = newer.recipient_id
              AND older.request_id IS NOT DISTINCT FROM newer.request_id
              AND older.type = newer.type
              AND older.created_at > newer.created_at
            """
        )
        connection.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS notifications_event_unique_idx
            ON notifications(recipient_id, request_id, type)
            """
        )
        connection.execute(
            """
            INSERT INTO notifications (recipient_id, request_id, type, message, created_at)
            SELECT lr.employee_id, lr.id, 'submitted',
                   'Your leave request was submitted for review.', lr.submitted_at
            FROM leave_requests lr
            WHERE NOT EXISTS (
                SELECT 1 FROM notifications n
                WHERE n.request_id = lr.id
                  AND n.recipient_id = lr.employee_id
                  AND n.type = 'submitted'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO notifications (recipient_id, request_id, type, message, created_at)
            SELECT om.manager_id, lr.id, 'submitted',
                   u.full_name || ' submitted a leave request for review.', lr.submitted_at
            FROM leave_requests lr
            JOIN users u ON u.id = lr.employee_id
            JOIN organization_managers om ON om.organization_id = lr.organization_id
            WHERE NOT EXISTS (
                SELECT 1 FROM notifications n
                WHERE n.request_id = lr.id
                  AND n.recipient_id = om.manager_id
                  AND n.type = 'submitted'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO notifications (recipient_id, request_id, type, message, created_at)
            SELECT lr.employee_id, lr.id, lr.status,
                   'Your leave request was ' || lr.status || ' by ' || COALESCE(u.full_name, 'a manager') || '.',
                   COALESCE(lr.decided_at, lr.submitted_at)
            FROM leave_requests lr
            LEFT JOIN users u ON u.id = lr.decided_by
            WHERE lr.status IN ('approved', 'rejected')
              AND NOT EXISTS (
                  SELECT 1 FROM notifications n
                  WHERE n.request_id = lr.id
                    AND n.recipient_id = lr.employee_id
                    AND n.type = lr.status
              )
            """
        )
        connection.execute(
            """
            INSERT INTO notifications (recipient_id, request_id, type, message, created_at)
            SELECT om.manager_id, lr.id, 'cancelled',
                   u.full_name || ' cancelled a leave request.', now()
            FROM leave_requests lr
            JOIN users u ON u.id = lr.employee_id
            JOIN organization_managers om ON om.organization_id = lr.organization_id
            WHERE lr.status = 'cancelled'
              AND NOT EXISTS (
                  SELECT 1 FROM notifications n
                  WHERE n.request_id = lr.id
                    AND n.recipient_id = om.manager_id
                    AND n.type = 'cancelled'
              )
            """
        )
        connection.commit()


def token_for(user):
    payload = {"sub": str(user["id"]), "organization_id": str(user["organization_id"]), "exp": datetime.utcnow() + timedelta(hours=8)}
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def current_user(credentials: HTTPAuthorizationCredentials = Depends(bearer)):
    try:
        payload = jwt.decode(credentials.credentials, JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from exc
    with db() as connection:
        user = connection.execute("SELECT * FROM users WHERE id = %s AND is_active = true", (payload["sub"],)).fetchone()
    if not user:
        raise HTTPException(status_code=401, detail="User is inactive or missing")
    return user


def require_manager(user=Depends(current_user)):
    if user["role"] != "manager":
        raise HTTPException(status_code=403, detail="Manager access required")
    return user


def require_admin(user=Depends(require_manager)):
    if not user["is_admin"]:
        raise HTTPException(status_code=403, detail="Administrator access required")
    return user


@app.get("/admin/accounts")
def admin_accounts(user=Depends(require_admin)):
    with db() as connection:
        return connection.execute(
            "SELECT id, full_name, email, role, is_admin, is_active FROM users WHERE organization_id = %s ORDER BY full_name",
            (user["organization_id"],),
        ).fetchall()


@app.post("/admin/accounts")
def create_manager_account(body: dict, user=Depends(require_admin)):
    name = (body.get("full_name") or "").strip()
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    if not name or not email or len(password) < 8:
        raise HTTPException(status_code=400, detail="Name, valid email, and password of at least 8 characters are required")
    password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    try:
        with db() as connection:
            account = connection.execute(
                "INSERT INTO users (organization_id, full_name, email, password_hash, role, is_admin) VALUES (%s, %s, %s, %s, 'manager', %s) RETURNING id, full_name, email, role, is_admin, is_active",
                (user["organization_id"], name, email, password_hash, bool(body.get("is_admin"))),
            ).fetchone()
            connection.execute(
                "INSERT INTO organization_managers (organization_id, manager_id) VALUES (%s, %s)",
                (user["organization_id"], account["id"]),
            )
            connection.commit()
            return account
    except psycopg.errors.UniqueViolation as exc:
        raise HTTPException(status_code=409, detail="An account with this email already exists") from exc


@app.patch("/admin/accounts/{account_id}")
def update_manager_account(account_id: str, body: dict, user=Depends(require_admin)):
    allowed = {key: body[key] for key in ("is_admin", "is_active") if key in body}
    if not allowed:
        raise HTTPException(status_code=400, detail="No supported account changes provided")
    with db() as connection:
        account = connection.execute(
            "UPDATE users SET is_admin = COALESCE(%s, is_admin), is_active = COALESCE(%s, is_active) WHERE id = %s AND organization_id = %s AND role = 'manager' RETURNING id, full_name, email, role, is_admin, is_active",
            (allowed.get("is_admin"), allowed.get("is_active"), account_id, user["organization_id"]),
        ).fetchone()
        if not account:
            raise HTTPException(status_code=404, detail="Manager account not found")
        connection.commit()
        return account


def working_days(start: date, end: date, organization_holidays: Set[date]) -> int:
    total = 0
    cursor = start
    while cursor <= end:
        if cursor.weekday() < 5 and cursor not in organization_holidays:
            total += 1
        cursor += timedelta(days=1)
    return total


def is_working_day(day: date, organization_holidays: Set[date]) -> bool:
    return day.weekday() < 5 and day not in organization_holidays


def get_organization_holidays(connection, organization_id):
    rows = connection.execute(
        "SELECT holiday_date FROM organization_holidays WHERE organization_id = %s",
        (organization_id,),
    ).fetchall()
    return {row["holiday_date"] for row in rows}


class OrganizationHolidayCreate(BaseModel):
    holiday_date: date
    name: str


@app.get("/organization/holidays")
def organization_holidays(user=Depends(current_user)):
    with db() as connection:
        return connection.execute(
            "SELECT id, holiday_date, name FROM organization_holidays WHERE organization_id = %s ORDER BY holiday_date",
            (user["organization_id"],),
        ).fetchall()


@app.post("/manager/holidays", status_code=201)
def create_organization_holiday(body: OrganizationHolidayCreate, user=Depends(require_manager)):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Holiday name is required")
    try:
        with db() as connection:
            row = connection.execute(
                "INSERT INTO organization_holidays (organization_id, holiday_date, name, created_by) VALUES (%s, %s, %s, %s) RETURNING id, holiday_date, name",
                (user["organization_id"], body.holiday_date, name, user["id"]),
            ).fetchone()
            connection.commit()
            return row
    except psycopg.errors.UniqueViolation as exc:
        raise HTTPException(status_code=409, detail="A holiday is already defined on that date") from exc


@app.delete("/manager/holidays/{holiday_id}")
def delete_organization_holiday(holiday_id: str, user=Depends(require_manager)):
    with db() as connection:
        deleted = connection.execute(
            "DELETE FROM organization_holidays WHERE id = %s AND organization_id = %s RETURNING id",
            (holiday_id, user["organization_id"]),
        ).fetchone()
        if not deleted:
            raise HTTPException(status_code=404, detail="Holiday not found")
        connection.commit()
    return {"message": "Holiday removed"}


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class LeaveRequestCreate(BaseModel):
    leave_type: str
    start_date: date
    end_date: date
    reason: str


class PasswordChange(BaseModel):
    current_password: str
    new_password: str


def create_notification(connection, recipient_id, request_id, notification_type, message):
    connection.execute(
        """
        INSERT INTO notifications (recipient_id, request_id, type, message)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (recipient_id, request_id, type) DO NOTHING
        """,
        (recipient_id, request_id, notification_type, message),
    )


@app.get("/health")
def health():
    with db() as connection:
        connection.execute("SELECT 1")
    return {"status": "ok"}


@app.post("/auth/login")
def login(body: LoginRequest):
    with db() as connection:
        user = connection.execute("SELECT * FROM users WHERE lower(email) = lower(%s) AND is_active = true", (body.email,)).fetchone()
    if not user or not bcrypt.checkpw(body.password.encode(), user["password_hash"].encode()):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return {"access_token": token_for(user), "token_type": "bearer", "user": {"id": str(user["id"]), "name": user["full_name"], "email": user["email"], "role": user["role"], "is_admin": user["is_admin"]}}


@app.get("/me")
def me(user=Depends(current_user)):
    return {"id": str(user["id"]), "name": user["full_name"], "email": user["email"], "role": user["role"], "is_admin": user["is_admin"]}


@app.get("/leave/balances")
def balances(user=Depends(current_user)):
    with db() as connection:
        rows = connection.execute("SELECT leave_type, entitlement_days, used_days, entitlement_days - used_days AS remaining_days FROM leave_balances WHERE user_id = %s ORDER BY leave_type", (user["id"],)).fetchall()
    return rows


@app.get("/leave/requests")
def my_requests(user=Depends(current_user)):
    with db() as connection:
        return connection.execute(
            """
            SELECT lr.*, submitter.full_name AS submitted_by_name,
                   decider.full_name AS decided_by_name
            FROM leave_requests lr
            JOIN users submitter ON submitter.id = lr.employee_id
            LEFT JOIN users decider ON decider.id = lr.decided_by
            WHERE lr.employee_id = %s
            ORDER BY lr.submitted_at DESC
            """,
            (user["id"],),
        ).fetchall()


@app.post("/leave/requests", status_code=201)
def create_leave_request(body: LeaveRequestCreate, user=Depends(current_user)):
    if body.leave_type not in ("earned", "sick") or body.end_date < body.start_date:
        raise HTTPException(status_code=400, detail="Invalid leave type or date range")
    with db() as connection:
        organization_holidays = get_organization_holidays(connection, user["organization_id"])
        if not is_working_day(body.start_date, organization_holidays) or not is_working_day(body.end_date, organization_holidays):
            raise HTTPException(status_code=400, detail="Leave must start and end on working days; weekends and organization holidays cannot be selected")
        days = working_days(body.start_date, body.end_date, organization_holidays)
        if days < 1:
            raise HTTPException(status_code=400, detail="Leave must include at least one working day after weekends and organization holidays")
        balance = connection.execute("SELECT entitlement_days - used_days AS remaining_days FROM leave_balances WHERE user_id = %s AND leave_type = %s", (user["id"], body.leave_type)).fetchone()
        if not balance or days > balance["remaining_days"]:
            raise HTTPException(status_code=400, detail="Insufficient leave balance")
        try:
            row = connection.execute("INSERT INTO leave_requests (organization_id, employee_id, leave_type, start_date, end_date, working_days, reason) VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING *", (user["organization_id"], user["id"], body.leave_type, body.start_date, body.end_date, days, body.reason)).fetchone()
            create_notification(connection, user["id"], row["id"], "submitted", "Your leave request was submitted for review.")
            managers = connection.execute(
                "SELECT manager_id FROM organization_managers WHERE organization_id = %s",
                (user["organization_id"],),
            ).fetchall()
            for manager in managers:
                create_notification(connection, manager["manager_id"], row["id"], "submitted", f"{user['full_name']} submitted a leave request for review.")
            connection.commit()
        except psycopg.errors.ExclusionViolation as exc:
            connection.rollback()
            raise HTTPException(status_code=409, detail="These dates overlap a pending or approved request") from exc
    return row


@app.get("/manager/requests")
def manager_requests(user=Depends(require_manager)):
    with db() as connection:
        return connection.execute(
            """
            SELECT lr.*, u.full_name AS employee_name, u.email AS employee_email,
                   decider.full_name AS decided_by_name
            FROM leave_requests lr
            JOIN users u ON u.id = lr.employee_id
            LEFT JOIN users decider ON decider.id = lr.decided_by
            WHERE lr.organization_id = %s
            ORDER BY lr.submitted_at DESC
            """,
            (user["organization_id"],),
        ).fetchall()


@app.get("/manager/dashboard")
def manager_dashboard(user=Depends(require_manager)):
    with db() as connection:
        stats = connection.execute(
            """
            WITH request_stats AS (
                SELECT
                    count(*) FILTER (WHERE status = 'pending') AS pending_requests,
                    coalesce(sum(working_days) FILTER (WHERE status = 'pending'), 0) AS pending_days,
                    count(*) FILTER (
                        WHERE status = 'approved'
                          AND decided_at >= date_trunc('year', CURRENT_DATE)
                          AND decided_at < date_trunc('year', CURRENT_DATE) + interval '1 year'
                    ) AS approved_this_year
                FROM leave_requests
                WHERE organization_id = %s
            ), people_stats AS (
                SELECT
                    count(*) FILTER (WHERE role = 'employee' AND is_active = true) AS active_employees,
                    count(*) FILTER (WHERE role = 'manager' AND is_active = true) AS active_managers
                FROM users
                WHERE organization_id = %s
            )
            SELECT request_stats.*, people_stats.*
            FROM request_stats CROSS JOIN people_stats
            """,
            (user["organization_id"], user["organization_id"]),
        ).fetchone()
    return stats


@app.patch("/manager/requests/{request_id}")
def decide_request(request_id: str, decision: dict, user=Depends(require_manager)):
    next_status = decision.get("status")
    if next_status not in ("approved", "rejected"):
        raise HTTPException(status_code=400, detail="Status must be approved or rejected")
    with db() as connection:
        request = connection.execute("SELECT * FROM leave_requests WHERE id = %s AND organization_id = %s FOR UPDATE", (request_id, user["organization_id"])).fetchone()
        if not request or request["status"] != "pending":
            raise HTTPException(status_code=404, detail="Pending request not found")
        if next_status == "approved":
            updated = connection.execute("UPDATE leave_balances SET used_days = used_days + %s WHERE user_id = %s AND leave_type = %s AND entitlement_days - used_days >= %s RETURNING id", (request["working_days"], request["employee_id"], request["leave_type"], request["working_days"])).fetchone()
            if not updated:
                raise HTTPException(status_code=400, detail="Insufficient balance at approval time")
        result = connection.execute("UPDATE leave_requests SET status = %s, decided_at = now(), decided_by = %s WHERE id = %s RETURNING *", (next_status, user["id"], request_id)).fetchone()
        create_notification(
            connection,
            request["employee_id"],
            request_id,
            next_status,
            f"Your leave request was {next_status} by {user['full_name']}.",
        )
        connection.commit()
    return result


@app.get("/notifications")
def notifications(user=Depends(current_user)):
    with db() as connection:
        return connection.execute(
            """
            SELECT id, request_id, type, message, read_at, created_at
            FROM notifications
            WHERE recipient_id = %s
            ORDER BY created_at DESC
            LIMIT 50
            """,
            (user["id"],),
        ).fetchall()


@app.post("/notifications/read")
def mark_notifications_read(user=Depends(current_user)):
    with db() as connection:
        connection.execute(
            "UPDATE notifications SET read_at = now() WHERE recipient_id = %s AND read_at IS NULL",
            (user["id"],),
        )
        connection.commit()
    return {"message": "Notifications marked as read"}


@app.post("/leave/requests/{request_id}/cancel")
def cancel_leave_request(request_id: str, user=Depends(current_user)):
    with db() as connection:
        result = connection.execute(
            "UPDATE leave_requests SET status = 'cancelled' WHERE id = %s AND employee_id = %s AND status = 'pending' RETURNING *",
            (request_id, user["id"]),
        ).fetchone()
        if not result:
            raise HTTPException(status_code=400, detail="Only your pending requests can be cancelled")
        create_notification(connection, user["id"], request_id, "cancelled", "Your leave request was cancelled.")
        managers = connection.execute(
            "SELECT manager_id FROM organization_managers WHERE organization_id = %s",
            (user["organization_id"],),
        ).fetchall()
        for manager in managers:
            create_notification(
                connection,
                manager["manager_id"],
                request_id,
                "cancelled",
                f"{user['full_name']} cancelled a leave request.",
            )
        connection.commit()
    return result


@app.post("/auth/password")
def change_password(body: PasswordChange, user=Depends(current_user)):
    if len(body.new_password) < 8 or not bcrypt.checkpw(body.current_password.encode(), user["password_hash"].encode()):
        raise HTTPException(status_code=400, detail="Current password is incorrect or new password is too short")
    password_hash = bcrypt.hashpw(body.new_password.encode(), bcrypt.gensalt()).decode()
    with db() as connection:
        connection.execute("UPDATE users SET password_hash = %s WHERE id = %s", (password_hash, user["id"]))
        connection.commit()
    return {"message": "Password updated"}

