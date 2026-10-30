import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, tokenStore } from '../api.js';

export default function AdminLogin() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function submit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { token } = await api.login(username, password);
      tokenStore.set(token);
      navigate('/admin');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login">
      <form className="card" onSubmit={submit}>
        <h2>Admin login</h2>
        <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <div className="alert">{error}</div>}
        <button type="submit" disabled={loading}>{loading ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  );
}
