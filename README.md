# SEKURZEN Leave Management MVP

A small leave-management workspace for employees and managers. The MVP includes login, leave balances, request submission, overlap and balance validation, pending cancellation, and manager approval or rejection.

## Run locally

```bash
npm install
npm run dev
```

Open the local Vite URL shown in the terminal.

For local development, run the FastAPI backend at `http://127.0.0.1:8000`; the Vite frontend calls that address directly. For a separate frontend and API deployment, set `VITE_API_URL` to the public FastAPI origin before building (for example, `https://api.example.com`). If production routes `/api/*` to FastAPI on the same origin, set `VITE_API_URL=/api`. Configure `CORS_ORIGINS` in `backend/.env` to include the deployed frontend origin when using separate hosts.

## User accounts

The login form does not contain prefilled credentials. Users must be created through the application’s account-management flow or an approved provisioning process. Passwords must never be committed to source code, seed files, or documentation.

## PostgreSQL setup with psql

The React application uses the FastAPI backend for authentication and leave data. React should not connect directly to PostgreSQL; the backend API handles database access and authorization. The database schema is available in `database/schema.sql`.

On Windows, after installing PostgreSQL and adding its `bin` directory to `PATH`:

```powershell
psql -U postgres
```

Run these commands inside the `psql` prompt:

```sql
CREATE USER sekurzen_app WITH PASSWORD 'change-this-password';
CREATE DATABASE sekurzen OWNER sekurzen_app;
\q
```

From the project root, apply the schema:

```powershell
psql -U sekurzen_app -d sekurzen -f database/schema.sql
```

Verify the tables:

```powershell
psql -U sekurzen_app -d sekurzen -c "\dt"
```

The schema includes `users`, `leave_balances`, `leave_requests`, `organization_managers`, and `password_reset_requests`. Passwords must be stored as Argon2 or bcrypt hashes by the API, never as plain text.

## FastAPI backend

The API is in `backend/app.py`. Create a virtual environment and install its dependencies:

```powershell
cd C:\Users\Admin\OneDrive\projects\projectLMP
py -3.8 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r backend\requirements.txt
Copy-Item backend\.env.example backend\.env
```

Edit `backend\.env` and replace the database password and JWT secret. Start the API:

```powershell
uvicorn backend.app:app --reload --port 8000
```

Check it at `http://localhost:8000/health`. Start Vite in a second terminal with `npm run dev`; local frontend API calls go directly to `http://127.0.0.1:8000`.

Keep this terminal running while using the Vite frontend. Start the frontend in a second terminal from the project root with `npm run dev`. If Vite and FastAPI use different hosts in production, set `VITE_API_URL` to the deployed API origin at frontend build time and add the frontend origin to `CORS_ORIGINS`.

Check it at `http://localhost:8000/health`. Interactive API documentation is available at `http://localhost:8000/docs`.

Available API areas include `/auth/login`, `/me`, `/leave/balances`, `/leave/requests`, `/leave/requests/{request_id}/cancel`, `/manager/requests`, `/manager/dashboard`, `/notifications`, `/auth/password`.

## Product decisions

- Earned Leave starts at 12 days and Sick Leave at 10 days.
- Only approved requests reduce balances.
- Pending and approved requests block overlapping dates.
- Requests count Monday-Friday working days and exclude organization holidays configured by managers. Holidays falling on weekends are not shifted because weekends are already excluded.
- Authentication, leave data, and leave balances are persisted through the FastAPI service and PostgreSQL transactions, with authorization enforced server-side.
