import getpass
import os

import bcrypt
import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row


load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
DATABASE_URL = os.getenv("DATABASE_URL")

ACCOUNTS = (
    ("Demo Employee", "employee@sekurzen.com", "employee", False),
    ("Demo Manager One", "manager1@sekurzen.com", "manager", True),
    ("Demo Manager Two", "manager2@sekurzen.com", "manager", False),
)


def password_for(email):
    while True:
        password = getpass.getpass(f"Password for {email} (minimum 8 characters): ")
        confirmation = getpass.getpass("Confirm password: ")
        if len(password) < 8:
            print("Password must be at least 8 characters.")
        elif password != confirmation:
            print("Passwords do not match.")
        else:
            return password


def main():
    passwords = {email: password_for(email) for _, email, _, _ in ACCOUNTS}
    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as connection:
        organization = connection.execute(
            "SELECT id FROM organizations WHERE name = 'SEKURZEN' ORDER BY created_at LIMIT 1"
        ).fetchone()
        if not organization:
            raise RuntimeError("SEKURZEN organization not found. Run database/schema.sql first.")

        for name, email, role, is_admin in ACCOUNTS:
            password_hash = bcrypt.hashpw(passwords[email].encode(), bcrypt.gensalt()).decode()
            user = connection.execute(
                """
                INSERT INTO users (organization_id, full_name, email, password_hash, role, is_admin)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (organization_id, email) DO UPDATE SET
                    full_name = EXCLUDED.full_name,
                    password_hash = EXCLUDED.password_hash,
                    role = EXCLUDED.role,
                    is_admin = EXCLUDED.is_admin,
                    is_active = true
                RETURNING id
                """,
                (organization["id"], name, email, password_hash, role, is_admin),
            ).fetchone()
            connection.execute(
                """
                INSERT INTO leave_balances (user_id, leave_type, entitlement_days)
                VALUES (%s, 'earned', 12), (%s, 'sick', 10)
                ON CONFLICT (user_id, leave_type) DO NOTHING
                """,
                (user["id"], user["id"]),
            )
            if role == "manager":
                connection.execute(
                    """
                    INSERT INTO organization_managers (organization_id, manager_id)
                    VALUES (%s, %s)
                    ON CONFLICT DO NOTHING
                    """,
                    (organization["id"], user["id"]),
                )

    print("Demo accounts created or updated.")


if __name__ == "__main__":
    main()
