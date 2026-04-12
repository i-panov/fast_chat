import * as db from '@/db'

async function getAuthHeader(): Promise<Record<string, string>> {
  const auth = await db.getAuth()
  return auth?.access_token ? { Authorization: `Bearer ${auth.access_token}` } : {}
}

async function fetchJson<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers = { 'Content-Type': 'application/json', ...await getAuthHeader(), ...opts.headers }
  const res = await fetch(`/api${path}`, { ...opts, headers })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export interface AdminUser {
  id: string
  username: string
  email: string
  is_admin: boolean
  disabled: boolean
  totp_enabled: boolean
  require_2fa: boolean
  created_at: string
  updated_at: string
}

export const userApi = {
  async list(page = 1, pageSize = 50): Promise<AdminUser[]> {
    return fetchJson<AdminUser[]>(`/users?page=${page}&page_size=${pageSize}`)
  },

  async create(user: { username: string; email: string; is_admin?: boolean }): Promise<AdminUser> {
    return fetchJson<AdminUser>('/users', { method: 'POST', body: JSON.stringify(user) })
  },

  async update(id: string, user: { username?: string; email?: string }): Promise<AdminUser> {
    return fetchJson<AdminUser>(`/users/${id}`, { method: 'PUT', body: JSON.stringify(user) })
  },

  async delete(id: string): Promise<void> {
    return fetchJson<void>(`/users/${id}`, { method: 'DELETE' })
  },

  async setAdmin(id: string, isAdmin: boolean): Promise<void> {
    return fetchJson<void>(`/users/${id}/admin`, { method: 'PUT', body: JSON.stringify({ is_admin: isAdmin }) })
  },

  async setDisabled(id: string, disabled: boolean): Promise<void> {
    return fetchJson<void>(`/users/${id}/disable`, { method: 'PUT', body: JSON.stringify({ disabled }) })
  },
}

export interface ServerSettings {
  allow_registration: boolean
  require_2fa: boolean
}

export const serverApi = {
  async health(): Promise<{ status: string; version: string; uptime_seconds: number; active_calls: number }> {
    return fetchJson('/admin/health')
  },

  async stats(): Promise<{ total_users: number; total_chats: number; total_messages: number; active_calls: number; uptime_seconds: number }> {
    return fetchJson('/stats')
  },

  async getSettings(): Promise<ServerSettings> {
    return fetchJson('/admin/settings')
  },

  async updateSettings(settings: Partial<ServerSettings>): Promise<ServerSettings> {
    return fetchJson('/admin/settings', { method: 'PUT', body: JSON.stringify(settings) })
  },
}
