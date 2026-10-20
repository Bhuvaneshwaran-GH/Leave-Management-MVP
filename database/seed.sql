-- Initialize leave data for users created through the application.
-- Run with: psql -U sekurzen_app -d sekurzen -f database\seed.sql

INSERT INTO leave_balances (user_id, leave_type, entitlement_days)
SELECT u.id, leave_type, entitlement_days
FROM users u
CROSS JOIN (VALUES ('earned', 12), ('sick', 10)) AS policy(leave_type, entitlement_days)
ON CONFLICT DO NOTHING;

INSERT INTO organization_managers (organization_id, manager_id)
SELECT o.id, u.id
FROM organizations o
CROSS JOIN users u
WHERE o.id = u.organization_id
  AND u.role = 'manager'
ON CONFLICT DO NOTHING;
