import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './overrides.css';
import './typography.css';
import './chrome.css';
import './brand-colors.css';
import './manager-ui.css';
import './visual-tuning.css';
import './admin-ui.css';
import './security-ui.css';
import './reset-ui.css';
import './sidebar-fix.css';

const POLICY = { earned: 12, sick: 10 };
const API_URL = (import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://127.0.0.1:8000' : '')).replace(/\/$/, '');
const APP_NAME = 'Leave Management Portal';
function workingDays(start, end, holidays = []) {
  if (!start || !end || end < start) return 0;
  const holidayDates = new Set(holidays.map((holiday) => holiday.holiday_date || holiday.date));
  let total = 0; const cursor = new Date(`${start}T12:00:00`); const finish = new Date(`${end}T12:00:00`);
  while (cursor <= finish) { const day = cursor.getDay(); const dateValue = cursor.toISOString().slice(0, 10); if (day !== 0 && day !== 6 && !holidayDates.has(dateValue)) total += 1; cursor.setDate(cursor.getDate() + 1); }
  return total;
}
function isNonWorkingDate(value, holidays = []) {
  if (!value) return false;
  const date = new Date(`${value}T12:00:00`);
  const dateValue = value.slice(0, 10);
  return date.getDay() === 0 || date.getDay() === 6 || holidays.some((holiday) => String(holiday.holiday_date || holiday.date).slice(0, 10) === dateValue);
}
function formatDate(value, compact = false) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-US', { month: compact ? 'short' : 'short', day: 'numeric', year: compact ? undefined : 'numeric' }).format(new Date(`${value}T12:00:00`));
}
function typeName(type) { return type === 'earned' ? 'Earned Leave' : 'Sick Leave'; }
function initials(name) { return name.split(' ').map((part) => part[0]).join(''); }
function getBalances(requests, employeeId) {
  return ['earned', 'sick'].reduce((result, type) => {
    result[type] = requests.filter((item) => item.employeeId === employeeId && item.type === type && item.status === 'Approved').reduce((sum, item) => sum + item.days, 0);
    return result;
  }, {});
}
function overlaps(a, b) { return a.start <= b.end && b.start <= a.end; }
function apiUser(user) { return { id: user.id, name: user.name, initials: initials(user.name), role: user.role === 'manager' ? 'Manager' : 'Employee', email: user.email, admin: user.is_admin }; }
async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('sekurzen-token');
  const method = options.method || 'GET';
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) } });
  } catch {
    throw new Error(`Cannot reach the API at ${API_URL || window.location.origin}. Start the FastAPI server or configure VITE_API_URL.`);
  }
  const raw = await response.text();
  let data = {};
  if (raw) {
    try { data = JSON.parse(raw); } catch { throw new Error(`API returned a non-JSON response (HTTP ${response.status}). Check the API URL and proxy configuration.`); }
  }
  if (!response.ok) throw new Error(`${method} ${path}: ${data.detail || response.statusText || 'Request failed'} (HTTP ${response.status}).`);
  return data;
}
function apiRequest(item) {
  return { id: item.id, employeeId: item.employee_id, employee: item.employee_name, type: item.leave_type, start: String(item.start_date), end: String(item.end_date), days: item.working_days, reason: item.reason, status: item.status[0].toUpperCase() + item.status.slice(1), submitted: String(item.submitted_at).slice(0, 10), submittedBy: item.submitted_by_name, decidedBy: item.decided_by_name, decidedAt: item.decided_at ? String(item.decided_at) : null };
}
function apiNotification(item) {
  return { id: item.id, requestId: item.request_id, type: item.type, message: item.message, createdAt: String(item.created_at), read: Boolean(item.read_at) };
}
function mergeNotifications(current, incoming) {
  const currentById = new Map(current.map((item) => [String(item.id), item]));
  const merged = incoming.map((item) => {
    const existing = currentById.get(String(item.id));
    return existing && existing.read ? { ...item, read: true } : item;
  });
  const incomingIds = new Set(incoming.map((item) => String(item.id)));
  return [...merged, ...current.filter((item) => String(item.id).startsWith('notification-') && !incomingIds.has(String(item.id)))];
}

function App() {
  const [user, setUser] = useState(null);
  const [view, setView] = useState('overview');
  const [requests, setRequests] = useState([]);
  const [balanceRows, setBalanceRows] = useState([]);
  const [dashboardStats, setDashboardStats] = useState(null);
  const [dashboardError, setDashboardError] = useState('');
  const [holidays, setHolidays] = useState([]);
  const unavailableEndpoints = useRef(new Set());
  const [accounts, setAccounts] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [toast, setToast] = useState('');
  const [selectedRequestId, setSelectedRequestId] = useState(null);
  const showToast = (message) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => current === message ? '' : current), 5000);
  };
  useEffect(() => {
    if (localStorage.getItem('sekurzen-fresh-start-v1')) return;
    ['sekurzen-requests', 'sekurzen-accounts'].forEach((key) => localStorage.removeItem(key));
    localStorage.setItem('sekurzen-fresh-start-v1', 'true');
  }, []);
  useEffect(() => {
    const sync = () => {
    };
    window.addEventListener('storage', sync);
    const timer = window.setInterval(sync, 1000);
    return () => { window.removeEventListener('storage', sync); window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!user) return;
    const load = async () => {
      try {
        const data = await apiFetch(user.role === 'Manager' ? '/manager/requests' : '/leave/requests');
        const mappedRequests = data.map(apiRequest);
        setRequests(mappedRequests);
        const incomingNotifications = (await apiFetch('/notifications')).map(apiNotification);
        setNotifications((current) => mergeNotifications(current, incomingNotifications));
        if (!unavailableEndpoints.current.has('/organization/holidays')) {
          try {
            setHolidays(await apiFetch('/organization/holidays'));
          } catch (error) {
            if (error.message.includes('HTTP 404')) unavailableEndpoints.current.add('/organization/holidays');
            showToast(error.message);
          }
        }
        if (user.role === 'Manager') {
          try {
            setDashboardStats(await apiFetch('/manager/dashboard'));
            setDashboardError('');
          } catch (error) {
            setDashboardError(error.message);
          }
          if (user.admin && view === 'accounts' && !unavailableEndpoints.current.has('/admin/accounts')) {
            try {
              const accountRows = await apiFetch('/admin/accounts');
              setAccounts(accountRows.map((item) => ({ id: item.id, name: item.full_name, initials: initials(item.full_name), role: item.role === 'manager' ? 'Manager' : 'Employee', email: item.email, admin: item.is_admin, active: item.is_active })));
            } catch (error) {
              if (error.message.includes('HTTP 404')) unavailableEndpoints.current.add('/admin/accounts');
              showToast(error.message);
            }
          }
        }
        if (user.role === 'Employee') setBalanceRows(await apiFetch('/leave/balances'));
      } catch (error) {
        setToast(error.message);
      }
    };
    load();
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, [user, view]);
  useEffect(() => {
    const token = localStorage.getItem('sekurzen-token');
    if (!token) return;
    apiFetch('/me')
      .then((data) => setUser(apiUser(data)))
      .catch(() => localStorage.removeItem('sekurzen-token'));
  }, []);
  const markNotificationsRead = async () => {
    try {
      await apiFetch('/notifications/read', { method: 'POST' });
      setNotifications((current) => current.map((item) => ({ ...item, read: true })));
    } catch (error) {
      setToast(error.message);
    }
  };

  if (!user) return <Login onLogin={(nextUser) => { setUser(nextUser); setView('overview'); }} />;
  const isManager = user.role === 'Manager';
  const visible = isManager ? requests : requests.filter((item) => item.employeeId === user.id);
  const balances = balanceRows.reduce((result, row) => ({ ...result, [row.leave_type]: row.used_days }), { earned: 0, sick: 0 });
  const navigate = (next) => setView(next);
  const openRequest = (id) => { setSelectedRequestId(id); setView('detail'); };
  const updatePassword = async ({ currentPassword, newPassword }) => {
    try {
      await apiFetch('/auth/password', { method: 'POST', body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) });
      return '';
    } catch (error) {
      return error.message;
    }
  };
  const updateAccounts = async (next, message) => {
    try {
      const previous = new Map(accounts.map((item) => [item.id, item]));
      const created = next.find((item) => !previous.has(item.id));
      if (created) await apiFetch('/admin/accounts', { method: 'POST', body: JSON.stringify({ full_name: created.name, email: created.email, password: created.password, is_admin: created.admin }) });
      for (const item of next) {
        const old = previous.get(item.id);
        if (old && (old.admin !== item.admin || old.active !== item.active)) await apiFetch(`/admin/accounts/${item.id}`, { method: 'PATCH', body: JSON.stringify({ is_admin: item.admin, is_active: item.active }) });
      }
      const rows = await apiFetch('/admin/accounts');
      setAccounts(rows.map((item) => ({ id: item.id, name: item.full_name, initials: initials(item.full_name), role: item.role === 'manager' ? 'Manager' : 'Employee', email: item.email, admin: item.is_admin, active: item.is_active })));
      if (message) { setToast(message); setTimeout(() => setToast(''), 2800); }
    } catch (error) {
      setToast(error.message);
    }
  };
  const updateRequest = async (id, status) => {
    const target = requests.find((item) => item.id === id);
    if (!target) return;
    try {
      await apiFetch(`/manager/requests/${id}`, { method: 'PATCH', body: JSON.stringify({ status: status.toLowerCase() }) });
      const data = await apiFetch('/manager/requests');
      setRequests(data.map(apiRequest));
      const incomingNotifications = (await apiFetch('/notifications')).map(apiNotification);
      setNotifications((current) => mergeNotifications(current, incomingNotifications));
      setToast(status === 'Approved' ? 'Request approved and balance updated.' : 'Request marked as rejected.');
    } catch (error) {
      setToast(error.message);
    }
  };
  const cancelRequest = async (id) => {
    const target = requests.find((item) => item.id === id);
    if (!target) return;
    try {
      await apiFetch(`/leave/requests/${id}/cancel`, { method: 'POST' });
      const data = await apiFetch('/leave/requests');
      setRequests(data.map(apiRequest));
      const incomingNotifications = (await apiFetch('/notifications')).map(apiNotification);
      setNotifications((current) => mergeNotifications(current, incomingNotifications));
      setToast('Pending request cancelled.');
    } catch (error) {
      setToast(error.message);
    }
  };
  const submitRequest = async (draft) => {
    try {
      await apiFetch('/leave/requests', { method: 'POST', body: JSON.stringify({ leave_type: draft.type, start_date: draft.start, end_date: draft.end, reason: draft.reason }) });
      const data = await apiFetch('/leave/requests');
      setRequests(data.map(apiRequest));
      setBalanceRows(await apiFetch('/leave/balances'));
      const incomingNotifications = (await apiFetch('/notifications')).map(apiNotification);
      setNotifications((current) => mergeNotifications(current, incomingNotifications));
      setToast('Leave request submitted for review.');
      setView('requests');
      return '';
    } catch (error) {
      return error.message;
    }
  };

  return <div className="app-shell">
    <Sidebar user={user} view={view} navigate={navigate} onLogout={() => { localStorage.removeItem('sekurzen-token'); setUser(null); }} />
    <main className="main-content">
      <Topbar user={user} notifications={notifications} onReadNotifications={markNotificationsRead} />
      {view === 'overview' && (isManager ? <ManagerDashboard requests={requests} stats={dashboardStats} statsError={dashboardError} navigate={navigate} onView={openRequest} /> : <Overview user={user} requests={visible} balances={balances} navigate={navigate} onView={openRequest} />)}
      {view === 'apply' && <Apply user={user} requests={visible} balances={balances} holidays={holidays} onSubmit={submitRequest} onCancel={() => navigate('overview')} />}
      {view === 'requests' && <Requests requests={visible} isManager={isManager} onCancel={cancelRequest} onUpdate={updateRequest} onApply={() => navigate('apply')} onView={openRequest} />}
      {isManager && view === 'team' && <ManagerOverview requests={requests} stats={dashboardStats} statsError={dashboardError} onUpdate={updateRequest} onView={openRequest} navigate={navigate} />}
      {isManager && view === 'processed' && <ProcessedRequests requests={requests.filter((item) => item.status !== 'Pending')} stats={dashboardStats} onView={openRequest} navigate={navigate} />}
      {isManager && user.admin && view === 'accounts' && <Accounts accounts={accounts.filter((item) => item.role === 'Manager')} currentUser={user} onUpdate={updateAccounts} />}
      {isManager && view === 'holidays' && <HolidaySettings holidays={holidays} onChange={setHolidays} />}
      {view === 'security' && <Security account={user} onUpdate={updatePassword} />}
      {view === 'detail' && selectedRequestId && <RequestDetail request={requests.find((item) => item.id === selectedRequestId)} isManager={isManager} onBack={() => navigate(isManager ? 'team' : 'requests')} onCancel={cancelRequest} onUpdate={updateRequest} />}
    </main>
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch('/auth/login', { method: 'POST', headers: {}, body: JSON.stringify({ email, password }) });
      localStorage.setItem('sekurzen-token', data.access_token);
      onLogin(apiUser(data.user));
    } catch (cause) {
      setError(cause.message || 'Unable to sign in.');
    } finally {
      setLoading(false);
    }
  };
  const [showPassword, setShowPassword] = useState(false);
  return <div className="login-page"><main className="login-stage"><section className="login-card"><div className="login-card-title">{APP_NAME}</div><form className="login-form" onSubmit={submit}><h2>Welcome back</h2><p className="muted">Sign in to manage your time away.</p><label>Work email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" autoComplete="email" required /></label><label>Password<div className="password-field"><input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" autoComplete="current-password" required />  <button type="button" className="password-toggle" onClick={() => setShowPassword(!showPassword)}>{showPassword ? 'Hide password' : 'Show password'}</button></div></label><label className="remember"><input type="checkbox" /> <span>Remember me</span></label>{error && <div className="alert alert-error">ⓘ &nbsp; {error}</div>}<button className="button button-primary full" disabled={loading}>{loading ? 'Signing in…' : 'Sign in'} <span>→</span></button></form></section></main></div>;
}

function Sidebar({ user, view, navigate, onLogout }) { return <aside className="sidebar"><div><div className="brand">{APP_NAME}</div><p className="workspace">{APP_NAME}</p><p className="nav-label">{user.role.toUpperCase()} WORKSPACE</p><nav><button className={view === 'overview' ? 'active' : ''} onClick={() => navigate('overview')}><span>⌘</span> Overview</button>{user.role === 'Employee' && <button className={view === 'apply' ? 'active' : ''} onClick={() => navigate('apply')}><span>＋</span> Apply for leave</button>}<button className={view === 'requests' || view === 'detail' && user.role === 'Employee' ? 'active' : ''} onClick={() => navigate('requests')}><span>≡</span> {user.role === 'Manager' ? 'Request inbox' : 'My requests'}</button>{user.role === 'Manager' && <><button className={view === 'processed' ? 'active' : ''} onClick={() => navigate('processed')}><span>✓</span> Processed requests</button><button className={view === 'holidays' ? 'active' : ''} onClick={() => navigate('holidays')}><span>▦</span> Public holidays</button></>}<button className={view === 'security' ? 'active' : ''} onClick={() => navigate('security')}><span>♙</span> {user.role === 'Manager' ? 'Password & security' : 'My account'}</button>{user.role === 'Manager' && user.admin && <button className={view === 'accounts' ? 'active' : ''} onClick={() => navigate('accounts')}><span>⚙</span> Manage accounts</button>}</nav></div><div className="sidebar-bottom"><div className="side-note"><span>◒</span><strong>Time away, made simple.</strong><small>22 days each year. A little room to rest and recharge.</small></div><button className="signout" onClick={onLogout}>↪ &nbsp; Sign out</button></div></aside>; }
function Topbar({ user, notifications, onReadNotifications }) { const [open, setOpen] = useState(false); const unread = notifications.filter((item) => !item.read).length; return <header className="topbar"><div className="breadcrumb">SEKURZEN <span>/</span> {user.role === 'Manager' ? 'Team leave' : 'My leave'}</div><div className="top-actions"><span className="today">{new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date())}</span><div className="notification-wrap"><button className="notification-button" aria-label={`${unread} unread notifications`} onClick={() => { const nextOpen = !open; setOpen(nextOpen); if (nextOpen) onReadNotifications(); }}>♢{unread > 0 && <span className="notification-count">{unread}</span>}</button>{open && <div className="notification-panel"><div className="notification-heading"><strong>Notifications</strong>{unread > 0 && <small>{unread} new</small>}</div>{notifications.length === 0 ? <p className="muted">No notifications yet.</p> : notifications.slice(0, 8).map((item) => <div className={`notification-item ${item.read ? '' : 'unread'}`} key={item.id}><span className="notification-dot" /><div><p>{item.message}</p><small>{formatDate(item.createdAt.slice(0, 10))}</small></div></div>)}</div>}</div><div className="avatar">{user.initials}</div><div className="user-label"><strong>{user.name}</strong><small>{user.role}</small></div></div></header>; }
function PageHeader({ eyebrow, title, subtitle, action }) { return <div className="page-header"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2><p className="muted">{subtitle}</p></div>{action}</div>; }
function BalanceCard({ type, used }) { const available = POLICY[type] - used; return <div className="balance-card"><div className="card-title"><strong>{typeName(type)}</strong><span className="soft-icon">{type === 'earned' ? '☼' : '♡'}</span></div><div className="balance-number">{available}<small>days remaining</small></div><div className="progress"><i style={{ width: `${(available / POLICY[type]) * 100}%` }} /></div><div className="balance-meta"><span>{POLICY[type]} annual entitlement</span><span>{used} approved used</span></div></div>; }
function Status({ value }) { return <span className={`status status-${value.toLowerCase()}`}>{value === 'Approved' ? '✓ ' : value === 'Pending' ? '◷ ' : value === 'Rejected' ? '× ' : '− '}{value}</span>; }
function RequestRow({ item, isManager, onCancel, onUpdate, onView }) { return <div className="request-row"><div><strong>{isManager ? item.employee : typeName(item.type)}</strong><small>{isManager ? typeName(item.type) : item.reason}</small></div><div>{formatDate(item.start)}{item.start !== item.end && ` – ${formatDate(item.end)}`}</div><div>{item.days} day{item.days !== 1 ? 's' : ''}</div><div>{formatDate(item.submitted)}</div><div><Status value={item.status} />{isManager && item.status !== 'Pending' && <small>by {item.decidedBy || 'manager'}</small>}</div><div className="row-actions">{isManager && item.status === 'Pending' ? <><button onClick={() => onView(item.id)}>Review</button></> : <><button onClick={() => onView(item.id)}>View</button>{!isManager && item.status === 'Pending' && <button className="text-danger" onClick={() => onCancel(item.id)}>Cancel</button>}</>}</div></div>; }
function Accounts({ accounts, currentUser, onUpdate }) { const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [isAdmin, setIsAdmin] = useState(false); const [error, setError] = useState(''); const managers = accounts.filter((account) => account.role === 'Manager'); const create = (event) => { event.preventDefault(); if (!name.trim() || !email.trim() || !password.trim()) { setError('Complete the name, email, and password fields.'); return; } if (accounts.some((account) => account.email.toLowerCase() === email.trim().toLowerCase())) { setError('An account with this email already exists.'); return; } const account = { id: `manager-${Date.now()}`, name: name.trim(), initials: initials(name.trim()), role: 'Manager', email: email.trim(), password, admin: isAdmin, active: true }; onUpdate([...accounts, account], 'Manager account created.'); setName(''); setEmail(''); setPassword(''); setIsAdmin(false); setError(''); }; const toggle = (id, key) => { const next = accounts.map((account) => account.id === id ? { ...account, [key]: !account[key] } : account); onUpdate(next, key === 'admin' ? 'Admin access updated.' : 'Account status updated.'); }; return <div className="page accounts-page"><PageHeader eyebrow="ADMINISTRATION / ACCOUNTS" title="Manage workspace access." subtitle="Create manager credentials and control administrator permissions." /><div className="accounts-layout"><form className="form-card account-form" onSubmit={create}><h3>Create manager account</h3><p className="muted">New managers can sign in immediately with these credentials.</p><label>Full name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Noah Williams" /></label><label>Work email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@sekurzen.com" /></label><label>Temporary password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Create a password" /></label><label className="admin-check"><input type="checkbox" checked={isAdmin} onChange={(event) => setIsAdmin(event.target.checked)} /> Grant administrator access</label>{error && <div className="alert alert-error">ⓘ &nbsp; {error}</div>}<button className="button button-primary" type="submit">＋ &nbsp; Create manager</button></form><section className="table-card account-list"><div className="section-heading"><div><h3>Manager accounts</h3><p className="muted">{managers.length} manager{managers.length !== 1 ? 's' : ''} in SEKURZEN</p></div></div>{managers.map((account) => <div className="account-row" key={account.id}><div className="avatar">{account.initials}</div><div className="account-info"><strong>{account.name}</strong><small>{account.email}</small></div><span className={`account-state ${account.active === false ? 'inactive' : ''}`}>{account.active === false ? 'Inactive' : 'Active'}</span>{account.admin && <span className="admin-badge">Admin</span>}<button className="link-button" onClick={() => toggle(account.id, 'admin')} disabled={account.id === currentUser.id}>{account.admin ? 'Remove admin' : 'Make admin'}</button><button className="link-button danger-link" onClick={() => toggle(account.id, 'active')} disabled={account.id === currentUser.id}>{account.active === false ? 'Reactivate' : 'Deactivate'}</button></div>)}</section></div></div>; }
function Security({ account, onUpdate }) { const [current, setCurrent] = useState(''); const [next, setNext] = useState(''); const [confirm, setConfirm] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const isManager = account.role === 'Manager'; const submit = async (event) => { event.preventDefault(); if (next.length < 8) { setError('Your new password must be at least 8 characters.'); return; } if (next !== confirm) { setError('The new passwords do not match.'); return; } const result = await onUpdate({ currentPassword: current, newPassword: next }); if (result) { setError(result); return; } setCurrent(''); setNext(''); setConfirm(''); setError(''); setMessage('Password updated successfully.'); }; return <div className="page security-page"><PageHeader eyebrow={isManager ? 'ACCOUNT / PASSWORD & SECURITY' : 'MY ACCOUNT / PASSWORD & SECURITY'} title="Make your account yours." subtitle="Change your password using your current password." /><div className="security-layout"><form className="form-card security-form" onSubmit={submit}><h3>Change password</h3><p className="muted">Use at least 8 characters. Your new password will be used the next time you sign in.</p><label>Current password<input type="password" value={current} onChange={(event) => setCurrent(event.target.value)} placeholder="Enter current password" /></label><label>New password<input type="password" value={next} onChange={(event) => setNext(event.target.value)} placeholder="Enter a new password" /></label><label>Confirm new password<input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} placeholder="Repeat the new password" /></label>{error && <div className="alert alert-error">ⓘ &nbsp; {error}</div>}{message && <div className="alert alert-success">{message}</div>}<button className="button button-primary" type="submit">Update password</button></form><aside className="security-card"><div className="security-icon">✓</div><h3>{account.name}</h3><p>{account.email}</p><span>{isManager ? `Manager account${account.admin ? ' · Administrator' : ''}` : 'Employee account'}</span><hr /><small>Changing your password does not affect your account permissions or leave requests.</small></aside></div></div>; }
function ManagerDashboard({ requests, stats, statsError, navigate, onView }) { const pending = requests.filter((item) => item.status === 'Pending'); return <div className="page manager-dashboard"><PageHeader eyebrow={`TEAM LEAVE · ${new Date().getFullYear()}`} title="A little clarity for the team." subtitle="Both managers see the same organization-wide request queue and decision history." action={<button className="button button-primary" onClick={() => navigate('team')}>Open request inbox →</button>} />{statsError && <div className="alert alert-error dashboard-api-error">Live dashboard metrics are unavailable: {statsError} The app will retry automatically.</div>}<section className="manager-stats"><div><span>Awaiting review</span><strong>{stats?.pending_requests ?? '—'}</strong><small>requests need your attention</small></div><div><span>Requested time</span><strong>{stats?.pending_days ?? '—'}</strong><small>working days across the team</small></div><div><span>Team members</span><strong>{stats?.active_employees ?? '—'}</strong><small>active employees in SEKURZEN</small></div></section><section className="manager-welcome"><div><p className="eyebrow">SHARED REVIEW QUEUE</p><h3>Make timely, fair decisions.</h3><p>Every manager sees every request. Approvals and rejections remain visible with the deciding manager named.</p><button className="link-button" onClick={() => navigate('processed')}>View processed requests →</button></div><div className="manager-summary"><span>Approved this year</span><strong>{stats?.approved_this_year ?? '—'}</strong><small>decisions recorded</small></div></section><section className="table-card full-table"><div className="section-heading"><h3>Needs your attention</h3><button className="link-button" onClick={() => navigate('team')}>View all pending →</button></div><RequestTable requests={pending.slice(0, 4)} isManager onView={onView} /></section></div>; }
function Overview({ user, requests, balances, navigate, onView }) { const next = requests.find((item) => item.status === 'Pending') || requests.find((item) => item.status === 'Approved'); const totalUsed = balances.earned + balances.sick; return <div className="page"><PageHeader eyebrow={`MY LEAVE · ${new Date().getFullYear()}`} title="A clear view of your time off." subtitle={`Good morning, ${user.name.split(' ')[0]}. Here’s where your leave stands today.`} action={<button className="button button-primary" onClick={() => navigate('apply')}>＋ &nbsp; Apply for leave</button>} /><section className="balance-grid"><BalanceCard type="earned" used={balances.earned} /><BalanceCard type="sick" used={balances.sick} /><div className="year-card"><p>YOUR YEAR AT A GLANCE</p><strong>{POLICY.earned + POLICY.sick}</strong><span>days a year</span><hr /><small>{totalUsed} approved used · {22 - totalUsed} remaining</small><em>Pending requests do not reduce days</em></div></section><section className="feature-grid">{next ? <div className="feature-card"><div className="date-tile"><small>{new Date(`${next.start}T12:00:00`).toLocaleString('en-US', { month: 'short' }).toUpperCase()}</small><strong>{new Date(`${next.start}T12:00:00`).getDate()}</strong></div><div><p className="eyebrow">{next.status === 'Pending' ? 'AWAITING A DECISION' : 'YOUR NEXT BREAK'}</p><strong>{formatDate(next.start)}{next.start !== next.end && ` – ${formatDate(next.end)}`}</strong><small>{typeName(next.type)} · {next.days} working day{next.days !== 1 ? 's' : ''}{next.reason ? ` · ${next.reason}` : ''}</small></div><Status value={next.status} /></div> : <div className="feature-card empty">No upcoming leave requests yet.</div>}<div className="rule-card"><strong>Leave policy at a glance</strong><p>12 earned days + 10 sick days are available each year. Only approved requests reduce your balance.</p><button className="link-button" onClick={() => navigate('requests')}>View request history →</button></div></section><section className="table-card"><div className="section-heading"><h3>Recent requests</h3><button className="link-button" onClick={() => navigate('requests')}>View all requests →</button></div><RequestTable requests={requests.slice(0, 3)} isManager={false} onView={onView} /></section><p className="footnote">ⓘ Full working days, Monday–Friday. Weekends and organization holidays cannot be selected as the first or last leave day.</p></div>; }
function RequestTable({ requests, isManager, onCancel, onUpdate, onView }) { return <div className="request-table"><div className="table-head"><span>{isManager ? 'EMPLOYEE' : 'LEAVE TYPE'}</span><span>DATES</span><span>DAYS</span><span>SUBMITTED</span><span>STATUS</span><span>ACTION</span></div>{requests.length ? requests.map((item) => <RequestRow key={item.id} item={item} isManager={isManager} onCancel={onCancel} onUpdate={onUpdate} onView={onView} />) : <div className="empty-table">No requests to show.</div>}</div>; }

function HolidaySettings({ holidays, onChange }) { const [holidayDate, setHolidayDate] = useState(''); const [name, setName] = useState(''); const [error, setError] = useState(''); const add = async (event) => { event.preventDefault(); setError(''); try { const row = await apiFetch('/manager/holidays', { method: 'POST', body: JSON.stringify({ holiday_date: holidayDate, name }) }); onChange((current) => [...current, row].sort((a, b) => a.holiday_date.localeCompare(b.holiday_date))); setHolidayDate(''); setName(''); } catch (cause) { setError(cause.message); } }; const remove = async (id) => { try { await apiFetch(`/manager/holidays/${id}`, { method: 'DELETE' }); onChange((current) => current.filter((item) => item.id !== id)); } catch (cause) { setError(cause.message); } }; return <div className="page"><PageHeader eyebrow="TEAM POLICY / HOLIDAYS" title="Set your organization holidays." subtitle="Saturday and Sunday are fixed weekly days off. Manager-declared holidays are excluded in addition to weekends." /><form className="form-card" onSubmit={add}><h3>Add a public holiday</h3><div className="date-fields"><label>Holiday name<input value={name} onChange={(event) => setName(event.target.value)} maxLength="120" required placeholder="e.g. Regional Foundation Day" /></label><label>Date<input type="date" value={holidayDate} onChange={(event) => setHolidayDate(event.target.value)} required /></label></div>{error && <div className="alert alert-error">ⓘ &nbsp; {error}</div>}<button className="button button-primary" type="submit">Add holiday</button></form><section className="table-card full-table"><div className="section-heading"><h3>Configured holidays</h3><span className="muted">{holidays.length} date{holidays.length === 1 ? '' : 's'}</span></div>{holidays.length ? holidays.map((item) => <div className="request-row" key={item.id}><div><strong>{item.name}</strong></div><div>{formatDate(String(item.holiday_date))}</div><div /><div /><div /><div className="row-actions"><button className="text-danger" onClick={() => remove(item.id)}>Remove</button></div></div>) : <div className="empty-table">No organization holidays configured.</div>}</section></div>; }

function Apply({ user, requests, balances, holidays, onSubmit, onCancel }) { const [type, setType] = useState('earned'); const [start, setStart] = useState(''); const [end, setEnd] = useState(''); const [reason, setReason] = useState(''); const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const days = workingDays(start, end, holidays); const blockedBoundary = isNonWorkingDate(start, holidays) || isNonWorkingDate(end, holidays); const available = POLICY[type] - balances[type]; const conflictingRequest = requests.find((item) => ['Pending', 'Approved'].includes(item.status) && overlaps({ start, end }, item)); const conflict = Boolean(conflictingRequest); const submit = async () => { setLoading(true); setError(''); const nextError = await onSubmit({ type, start, end, days, reason }); setError(nextError || ''); setLoading(false); }; return <div className="page"><PageHeader eyebrow="MY LEAVE / NEW REQUEST" title="Make room for time away." subtitle="Choose your dates. We’ll take care of the working-day count." /><div className="apply-layout"><section className="form-card"><h3>Leave details</h3><p className="muted">All fields are required. Requests are sent to your managers for review.</p><label>Leave type<select value={type} onChange={(event) => setType(event.target.value)}><option value="earned">Earned Leave</option><option value="sick">Sick Leave</option></select><small>{available} days remaining of {POLICY[type]} annual days</small></label><div className="date-fields"><label>Start date<input type="date" value={start} onChange={(event) => setStart(event.target.value)} /></label><label>End date<input type="date" value={end} min={start} onChange={(event) => setEnd(event.target.value)} /></label></div><div className="day-count">▣ &nbsp; <strong>{days} full working day{days !== 1 ? 's' : ''}</strong><small>Weekends and organization holidays cannot be selected as the first or last leave day</small></div><label>Reason<textarea value={reason} maxLength="500" onChange={(event) => setReason(event.target.value)} /><small className="character-count">{reason.length} / 500</small></label>{(error || conflict || blockedBoundary || days < 1 || days > available) && <div className="alert alert-error">ⓘ &nbsp; {error || (conflict ? `${typeName(conflictingRequest.type)} is already requested from ${formatDate(conflictingRequest.start)} to ${formatDate(conflictingRequest.end)} (${conflictingRequest.status}).` : blockedBoundary ? 'Start and end dates must be weekdays that are not organization holidays.' : days < 1 ? 'Choose a valid date range.' : `You have ${available} days available, not ${days}.`)}</div>} {!error && !conflict && !blockedBoundary && days >= 1 && days <= available && <div className="alert alert-success">✓ &nbsp; <strong>Your dates look good.</strong> No overlap found and enough balance is available.</div>}<div className="form-footer"><button className="button button-quiet" onClick={onCancel}>Discard</button><button className="button button-primary" disabled={!!error || conflict || blockedBoundary || days < 1 || days > available || !reason.trim()} onClick={submit}>→ &nbsp; Submit request</button></div></section><aside className="preview-card"><p className="eyebrow">YOUR BALANCE PREVIEW</p><h3>{typeName(type)}</h3><div className="preview-line"><span>Annual entitlement</span><strong>{POLICY[type]} days</strong></div><div className="preview-line"><span>Approved used</span><strong>{balances[type]} days</strong></div><div className="preview-line"><span>Available now</span><strong>{available} days</strong></div><div className="preview-line"><span>This request</span><strong>{days} days</strong></div><div className="remaining">Remaining if approved <strong>{available - days} days</strong></div><div className="policy-note"><strong>A few things to know</strong><p>Pending, rejected and cancelled requests do not reduce your balance. Balance is deducted only when approved.</p><p>Leave is counted in full working days. Weekends and organization holidays cannot be selected as the first or last leave day.</p></div></aside></div></div>; }
function Requests({ requests, isManager, onCancel, onUpdate, onApply, onView }) { return <div className="page"><PageHeader eyebrow={isManager ? 'TEAM LEAVE / REQUEST INBOX' : 'MY LEAVE / REQUEST HISTORY'} title={isManager ? 'A little clarity for the team.' : 'Every request, in one place.'} subtitle={isManager ? 'Review pending requests and help your people plan their time away.' : 'Track a decision, revisit your dates, or cancel a pending request.'} action={!isManager && <button className="button button-primary" onClick={onApply}>＋ &nbsp; Apply for leave</button>} /><section className="table-card full-table"><div className="section-heading"><h3>{isManager ? 'Pending requests' : 'All requests'}</h3><span className="muted">{requests.length} request{requests.length !== 1 ? 's' : ''}</span></div><RequestTable requests={requests} isManager={isManager} onCancel={onCancel} onUpdate={onUpdate} onView={onView} /></section></div>; }
function ManagerOverview({ requests, stats, statsError, onUpdate, onView, navigate }) { const pending = requests.filter((item) => item.status === 'Pending'); return <div className="page"><PageHeader eyebrow="TEAM LEAVE / SHARED INBOX" title="A little clarity for the team." subtitle="Review pending requests and help your people plan their time away." action={<button className="button button-quiet" onClick={() => navigate('processed')}>✓ &nbsp; Processed requests</button>} />{statsError && <div className="alert alert-error dashboard-api-error">Live dashboard metrics are unavailable: {statsError} The app will retry automatically.</div>}<section className="manager-stats"><div><span>Awaiting review</span><strong>{stats?.pending_requests ?? '—'}</strong><small>requests need your attention</small></div><div><span>Requested time</span><strong>{stats?.pending_days ?? '—'}</strong><small>working days across the team</small></div><div><span>Shared review</span><strong>{stats?.active_managers ?? '—'}</strong><small>active managers in SEKURZEN</small></div></section><section className="table-card full-table"><div className="section-heading"><h3>Pending requests</h3></div><RequestTable requests={pending} isManager onUpdate={onUpdate} onView={onView} /></section><div className="alert alert-success manager-note">ⓘ &nbsp; <strong>One shared queue for your managers.</strong> Pending requests do not deduct balance.</div></div>; }
function ProcessedRequests({ requests, stats, onView, navigate }) { return <div className="page"><PageHeader eyebrow="TEAM LEAVE / PROCESSED REQUESTS" title="Every decision, a clear record." subtitle="Previously approved and rejected requests across your managers." action={<button className="button button-quiet" onClick={() => navigate('team')}>← &nbsp; Request inbox</button>} /><section className="manager-stats"><div><span>Approved</span><strong>{requests.filter((item) => item.status === 'Approved').length}</strong><small>balances updated on approval</small></div><div><span>Rejected</span><strong>{requests.filter((item) => item.status === 'Rejected').length}</strong><small>no balance deducted</small></div><div><span>Reviewing managers</span><strong>{stats?.active_managers ?? '—'}</strong><small>active managers in SEKURZEN</small></div></section><section className="table-card full-table"><div className="section-heading"><h3>Processed requests</h3><span className="muted">{requests.length} decisions</span></div><RequestTable requests={requests} isManager onView={onView} /></section><div className="alert alert-success manager-note">ⓘ &nbsp; <strong>Processed requests are read-only.</strong> Approval deducts leave; rejection does not change balances.</div></div>; }

function RequestDetail({ request, isManager, onBack, onCancel, onUpdate }) { if (!request) return null; const approvedUsed = request.status === 'Approved' ? request.days : 0; return <div className="page detail-page"><button className="back-link" onClick={onBack}>← &nbsp; {isManager ? 'Request inbox' : 'My requests'}</button><PageHeader eyebrow={`${isManager ? 'TEAM LEAVE' : 'MY LEAVE'} / ${request.id}`} title={isManager ? `Review ${request.employee}'s request.` : request.status === 'Pending' ? 'Your request is with the team.' : 'Your request details.'} subtitle={isManager ? 'Check the details and balance before you make a decision.' : request.status === 'Pending' ? 'Waiting for a manager to review your time away.' : 'A complete record of your time away request.'} /><div className="detail-layout"><section><div className="detail-card"><div className="detail-title"><div><small>{request.id}</small><h3>{typeName(request.type)}</h3></div><Status value={request.status} /></div><hr /><div className="detail-dates"><div><small>Start date</small><strong>{formatDate(request.start)}</strong></div><span>→</span><div><small>End date</small><strong>{formatDate(request.end)}</strong></div></div><div className="day-count"><strong>{request.days} full working days</strong><small>Monday–Friday · No weekend days included</small></div><div className="reason"><small>Reason for leave</small><p>{request.reason}</p></div><div className="detail-meta"><div><small>Submitted</small><strong>{formatDate(request.submitted)}</strong></div><div><small>{isManager ? 'Employee' : 'Status'}</small><strong>{isManager ? `${request.employee} · Team member` : request.status}</strong></div></div></div><div className="detail-card activity"><h3>Request activity</h3><p>✓ &nbsp; Requested by {request.submittedBy || (isManager ? request.employee : 'you')}</p><small>{formatDate(request.submitted)} · Request recorded in SEKURZEN</small>{request.status !== 'Pending' && <><p>{request.status === 'Approved' ? '✓' : '×'} &nbsp; {request.status} by {request.decidedBy || 'manager'}</p><small>{request.decidedAt ? formatDate(request.decidedAt.slice(0, 10)) : ''} · Decision recorded in SEKURZEN</small></>}</div></section><aside>{isManager ? <div className="decision-card"><p className="eyebrow">YOUR DECISION</p><h3>Review this request</h3><p className="muted">{request.days} days of {typeName(request.type)} requested. Balance is only deducted after approval.</p><div className="decision-balance">Available if approved <strong>{12 - approvedUsed} days</strong></div><div className="decision-actions"><button className="button button-primary" disabled={request.status !== 'Pending'} onClick={() => onUpdate(request.id, 'Approved')}>✓ &nbsp; Approve request</button><button className="button button-danger" disabled={request.status !== 'Pending'} onClick={() => onUpdate(request.id, 'Rejected')}>× &nbsp; Reject</button></div></div> : request.status === 'Pending' ? <div className="decision-card cancel-panel"><p className="eyebrow">PENDING REQUEST</p><h3>Cancel this request?</h3><p className="muted">Your request will be removed from the review queue. Your balance will not change.</p><div className="decision-balance">No days deducted <strong>Balance unchanged</strong></div><button className="button button-danger full" onClick={() => onCancel(request.id)}>Yes, cancel request</button><button className="link-button" onClick={onBack}>Keep my request</button></div> : <div className="decision-card"><p className="eyebrow">REQUEST COMPLETE</p><h3>{request.status === 'Approved' ? 'Time off approved.' : 'Request rejected.'}</h3><p className="muted">This decision is recorded. {request.status === 'Approved' ? `${request.days} days were deducted from the balance.` : 'No balance was deducted.'}</p></div>}</aside></div></div>; }

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
