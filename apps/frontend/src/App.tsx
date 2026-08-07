import { Navigate, Route, Routes } from 'react-router-dom'
import './App.css'
import { Layout } from './components/Layout'
import { ProtectedRoute } from './components/ProtectedRoute'
import { DashboardPage } from './pages/DashboardPage'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { StatementPage } from './pages/StatementPage'
import { TransactionDetailPage } from './pages/TransactionDetailPage'
import { TransferPage } from './pages/TransferPage'

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/statement" element={<StatementPage />} />
          <Route path="/transfer" element={<TransferPage />} />
          <Route path="/transactions/:id" element={<TransactionDetailPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
