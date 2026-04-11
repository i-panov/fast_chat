export interface User {
  id: string
  username: string
  is_admin: boolean
  disabled: boolean
  totp_enabled: boolean
  public_key: string | null
  created_at: string
  updated_at: string
}

export interface CreateUserRequest {
  username: string
  password: string
  is_admin?: boolean
}

export interface UpdateUserRequest {
  username?: string
  disabled?: boolean
}

export interface HealthResponse {
  status: string
  version: string
  uptime_seconds: number
  active_calls: number
}

export interface StatsResponse {
  total_users: number
  total_chats: number
  total_messages: number
  active_calls: number
  uptime_seconds: number
}
