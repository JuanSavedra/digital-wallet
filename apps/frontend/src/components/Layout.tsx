import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/auth-context';

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
        <span className="brand">Carteira Digital</span>
        <nav>
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          <NavLink to="/statement">Extrato</NavLink>
          <NavLink to="/transfer">Transferir</NavLink>
        </nav>
        <button type="button" onClick={() => void handleLogout()}>
          Sair
        </button>
      </header>
      <main className="app-content">
        <Outlet />
      </main>
    </div>
  );
}
