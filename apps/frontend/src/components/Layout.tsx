import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/auth-context';
import { ThemeToggle } from './ThemeToggle';

export function Layout() {
  const { logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    void navigate('/login', { replace: true });
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <NavLink to="/" end className="brand">
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="2" y="6" width="20" height="14" rx="3" />
            <path d="M2 10.5h20" />
            <circle cx="17" cy="15" r="1.3" fill="currentColor" stroke="none" />
          </svg>
          <span className="brand-label">Carteira Digital</span>
        </NavLink>
        <nav>
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          <NavLink to="/statement">Extrato</NavLink>
          <NavLink to="/transfer">Transferir</NavLink>
        </nav>
        <div className="header-actions">
          <ThemeToggle />
          <button type="button" onClick={() => void handleLogout()}>
            Sair
          </button>
        </div>
      </header>
      <main className="app-content">
        <Outlet />
      </main>
    </div>
  );
}
