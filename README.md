# SEKURZEN Leave Management Portal

A production-deployed full-stack leave management portal for employees and managers. The application includes JWT authentication, leave balances, request submission and cancellation, overlap and balance validation, manager approval or rejection, shared manager visibility, persistent notifications, and organization-wide public-holiday management.

## Production architecture

- **Frontend:** React/Vite deployed on Vercel.
- **Backend:** FastAPI deployed on Render.
- **Database:** PostgreSQL hosted on Render.
- **Authentication:** JWT bearer tokens with bcrypt password hashes.

Production services:

- Frontend: `https://leave-management-portal-966z-kzpft1836.vercel.app`
- API health check: `https://leave-management-mvp-966z.onrender.com/health`

Never commit `backend/.env` or paste production credentials into source files, documentation, or GitHub.

## Technology stack

- React 18 and Vite for the browser application.
- FastAPI and Python for the REST API.
- PostgreSQL for persistent application data, accessed with psycopg.
- bcrypt for password hashing and JWT bearer tokens for authenticated API requests.
- Vercel for the frontend and Render for the API and PostgreSQL database.

## Architecture overview

The browser application sends HTTPS requests to the FastAPI service. FastAPI validates credentials, issues JWTs, enforces employee/manager permissions, and reads or writes PostgreSQL data. The React application does not connect directly to PostgreSQL. The frontend and API are deployed separately, with CORS configured to allow the Vercel application origin.

## Features

### Employee features

- Secure login with JWT authentication.
- Dashboard with earned-leave and sick-leave balances.
- Leave application with leave type, date range, and reason.
- Automatic working-day calculation that excludes weekends and organization holidays.
- Validation for invalid dates, overlapping requests, and insufficient balance.
- Request history with pending, approved, rejected, and cancelled statuses.
- Cancellation of pending requests.
- Request details showing submission and decision history.
- Persistent in-app notifications for submissions, approvals, rejections, and cancellations.
- Read notifications remain marked as seen after page refresh or a new login.
- Password change support for authenticated users.

### Manager features

- Manager dashboard with organization request statistics.
- Shared organization-wide request queue visible to all managers in the organization.
- Request review with employee, leave dates, working days, reason, and status.
- Approve or reject requests with decision history.
- Decision-maker and decision-date visibility for employees and managers.
- Persistent notifications for new submissions and cancelled requests.
- Organization-wide public-holiday administration.
- Holiday-aware leave validation and date selection.

### Platform and reliability features

- Server-side authorization for employee and manager operations.
- PostgreSQL persistence for users, balances, requests, holidays, notifications, and audit details.
- Database-backed notification deduplication so the same event is not repeatedly created.
- Health endpoint for deployment monitoring.
- Separate Vercel and Render deployment configuration.

## Application workflow

### Employee leave workflow

1. The employee opens the Vercel application and signs in.
2. The frontend sends the credentials to the FastAPI `/auth/login` endpoint.
3. The backend validates the bcrypt password hash and returns a JWT.
4. The employee views current leave balances and existing requests.
5. The employee selects a leave type and date range. The application identifies weekends and organization holidays that are excluded from the calculation.
6. The backend validates the dates, working-day count, balance, and overlap rules.
7. A valid request is stored as `pending`, and a submission notification is created.
8. The employee can monitor the request history or cancel the request while it is pending.
9. The employee receives a persistent notification when a manager approves or rejects the request.
10. Approved requests reduce the relevant leave balance; rejected and cancelled requests do not.

### Manager review workflow

1. A manager signs in and opens the manager dashboard.
2. The backend limits manager actions to authorized manager accounts.
3. All managers assigned to the organization see the shared request queue.
4. A manager opens a request and reviews the employee, dates, working days, leave type, reason, and current status.
5. The manager approves or rejects the request.
6. The backend stores the decision, deciding manager, and decision timestamp.
7. The employee's balance is updated only for an approval.
8. The employee and relevant managers receive the corresponding persistent notification.

### Public-holiday workflow

1. An authorized manager opens public-holiday settings.
2. The manager adds an organization-wide holiday with a date and name.
3. The backend stores the holiday for the organization and prevents duplicate dates.
4. The holiday appears in the employee leave form and is excluded from working-day calculations.
5. Weekends remain weekly rest days and are not shifted when they overlap a holiday.

## Data model overview

- `organizations` groups accounts and organization-wide settings.
- `users` stores employee and manager profiles, roles, active status, and password hashes.
- `leave_balances` tracks earned and sick leave entitlement and usage per user.
- `leave_requests` stores requested dates, calculated working days, status, and decision details.
- `organization_managers` links managers to organizations.
- `organization_holidays` stores manager-declared organization holidays.
- `notifications` stores leave request and decision notifications for users.
- `password_reset_requests` stores reset requests where that workflow is enabled.

## Assumptions

- Each user belongs to one organization; the current deployment is configured for SEKURZEN.
- Leave entitlement starts at 12 earned days and 10 sick days per year.
- Monday through Friday are working days. Saturdays, Sundays, and manager-declared organization holidays are excluded from leave-day calculations and cannot be selected as the first or last leave date.
- Only approved leave reduces the balance. Pending and approved requests cannot overlap for the same employee.
- Managers in the organization share visibility of requests and decision history.

## Known limitations

- The current product setup is a single-organization MVP; there is no organization onboarding or tenant administration UI.
- User passwords are provisioned by an administrator. Password recovery by email is not configured.
- Notifications are stored and shown in the application; external email or push delivery is not configured.
- Leave policies are fixed in the application and do not yet support per-user accrual schedules or configurable entitlement rules.
- Demo accounts must be provisioned with the script below. Passwords are chosen at provisioning time and are not published in this repository.

## Run locally

```bash
npm install
npm run dev
```

Open the local Vite URL shown in the terminal.

For local development, run the FastAPI backend at `http://127.0.0.1:8000`; the Vite frontend calls that address directly. For a separate frontend and API deployment, set `VITE_API_URL` to the public FastAPI origin before building (for example, `https://api.example.com`). If production routes `/api/*` to FastAPI on the same origin, set `VITE_API_URL=/api`. Configure `CORS_ORIGINS` in `backend/.env` to include the deployed frontend origin when using separate hosts.

## User accounts

The login form does not contain prefilled credentials. To create/reset the demo manager account or employee account, configure `backend/.env` with the target database URL and run one of these from the repository root:

```powershell
python backend\seed_demo_accounts.py --manager-only
python backend\seed_demo_accounts.py --employee-only
```

The script prompts for a password of at least eight characters. Share the resulting demo email and chosen password privately with the evaluator alongside the repository link. Do not put passwords in this public README, source code, seed files, or GitHub.

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

## Production deployment

### Render backend

Create a Render Web Service from this repository with:

```text
Build Command: pip install -r backend/requirements.txt
Start Command: uvicorn backend.app:app --host 0.0.0.0 --port $PORT
```

Configure these environment variables in the Render Web Service. Keep their values private:

```text
DATABASE_URL=<Render PostgreSQL Internal Database URL>
JWT_SECRET=<long random secret>
CORS_ORIGINS=https://leave-management-portal-966z-kzpft1836.vercel.app
```

Apply the database schema once using the PostgreSQL connection details from Render:

```powershell
psql "<external-database-url>" -f database\schema.sql
psql "<external-database-url>" -f database\seed.sql
```

The database URL used by the deployed backend should be the Render PostgreSQL **Internal Database URL**. Cron jobs are not required.

### Vercel frontend

Create a Vercel project from this repository with:

```text
Framework Preset: Vite
Build Command: npm run build
Output Directory: dist
```

Configure this Vercel environment variable before deploying:

```text
VITE_API_URL=https://leave-management-mvp-966z.onrender.com
```

After deployment, verify the API health URL and then test login from the Vercel frontend.

## Product decisions

- Earned Leave starts at 12 days and Sick Leave at 10 days.
- Only approved requests reduce balances.
- Pending and approved requests block overlapping dates.
- Requests count Monday-Friday working days and exclude organization holidays configured by managers. Holidays falling on weekends are not shifted because weekends are already excluded.
- Authentication, leave data, and leave balances are persisted through the FastAPI service and PostgreSQL transactions, with authorization enforced server-side.
