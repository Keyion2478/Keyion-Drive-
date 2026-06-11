import { Navigate, Outlet } from 'react-router-dom'
import { getAccessToken } from '@/lib/auth'

export function ProtectedRoute() {
  return getAccessToken() ? <Outlet /> : <Navigate to="/login" replace />
}
