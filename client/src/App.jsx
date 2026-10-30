import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, Link, NavLink, useLocation } from 'react-router-dom';
import ChatPage from './pages/ChatPage.jsx';
import AdminLogin from './pages/AdminLogin.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';
import AdminPolicies from './pages/AdminPolicies.jsx';
import AdminKnowledge from './pages/AdminKnowledge.jsx';
import { api, tokenStore } from './api.js';

function Protected({ children }) {
  return tokenStore.get() ? children : <Navigate to="/admin/login" replace />;
}

export default function App() {
  const { pathname } = useLocation();
  const [policy, setPolicy] = useState({ assistantName: '', userNotice: '' });

  // Assistant name + staff notice are set by the admin in Admin → Policies
  useEffect(() => {
    api.policy().then(setPolicy).catch(() => {});
  }, [pathname === '/']);

  const name = policy.assistantName || 'Local AI Assistant';
  useEffect(() => {
    document.title = name;
  }, [name]);

  const inAdmin = pathname.startsWith('/admin') && pathname !== '/admin/login' && tokenStore.get();

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">🦙 {name}</Link>
        <nav>
          <Link to="/" className={pathname === '/' ? 'active' : ''}>Chat</Link>
          {inAdmin ? (
            <>
              <NavLink to="/admin" end>Logs</NavLink>
              <NavLink to="/admin/knowledge">Knowledge</NavLink>
              <NavLink to="/admin/policies">Rules</NavLink>
            </>
          ) : (
            <Link to="/admin" className={pathname.startsWith('/admin') ? 'active' : ''}>Admin</Link>
          )}
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<ChatPage notice={policy.userNotice} assistantName={name} />} />
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/admin" element={<Protected><AdminDashboard /></Protected>} />
        <Route path="/admin/policies" element={<Protected><AdminPolicies /></Protected>} />
        <Route path="/admin/knowledge" element={<Protected><AdminKnowledge /></Protected>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
