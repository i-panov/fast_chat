import type { User, AuthResponse, Chat, Message, Channel, FileMeta, PendingMessage, SseEvent } from '@/types'
import * as db from '@/db'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8080'

// ─── HTTP Client ───
class ApiClient {
  private accessToken: string | null = null
  private refreshToken: string | null = null
  private refreshPromise: Promise<string> | null = null

  constructor() {
    // Restore tokens from DB
    this.init()
  }

  private async init() {
    const auth = await db.getAuth()
    if (auth) {
      this.accessToken = auth.access_token
      this.refreshToken = auth.refresh_token
    }
  }

  async getTokens() {
    return { access: this.accessToken, refresh: this.refreshToken }
  }

  private authHeaders(): Record<string, string> {
    return this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}
  }

  private async request<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const url = `${API_BASE}${path}`
    const headers = { 'Content-Type': 'application/json', ...this.authHeaders(), ...opts.headers }

    let response = await fetch(url, { ...opts, headers })

    if (response.status === 401 && this.refreshToken && !this.refreshPromise) {
      this.refreshPromise = this.doRefresh()
      try {
        this.accessToken = await this.refreshPromise
      } finally {
        this.refreshPromise = null
      }
      // Retry with new token
      headers.Authorization = `Bearer ${this.accessToken}`
      response = await fetch(url, { ...opts, headers })
    }

    if (response.status === 401) {
      await db.clearAuth()
      this.accessToken = null
      this.refreshToken = null
      throw new Error('AUTH_REQUIRED')
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.error || `HTTP ${response.status}`)
    }

    return response.json()
  }

  private async doRefresh(): Promise<string> {
    const res = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: this.refreshToken }),
    })
    if (!res.ok) throw new Error('Refresh failed')
    const data = await res.json() as AuthResponse
    this.accessToken = data.access_token
    this.refreshToken = data.refresh_token
    await db.saveAuth({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user })
    return data.access_token
  }

  // ─── Auth ───
  async requestCode(email: string): Promise<{ message: string; dev_code?: string }> {
    return this.request('/api/auth/request-code', { method: 'POST', body: JSON.stringify({ email }) })
  }

  async verifyCode(email: string, code: string, totpCode?: string): Promise<AuthResponse | { need_2fa: boolean; user_id: string; require_2fa?: boolean }> {
    const body = await this.request<AuthResponse | { need_2fa: boolean; user_id: string; require_2fa?: boolean }>(
      '/api/auth/verify-code',
      { method: 'POST', body: JSON.stringify({ email, code, totp_code: totpCode }) }
    )
    if ('access_token' in body) {
      this.accessToken = body.access_token
      this.refreshToken = body.refresh_token
      await db.saveAuth({ access_token: body.access_token, refresh_token: body.refresh_token, user: body.user })
    }
    return body
  }

  async verify2fa(userId: string, totpCode: string): Promise<AuthResponse | { need_2fa: boolean; user_id: string; require_2fa?: boolean }> {
    const body = await this.request<AuthResponse | { need_2fa: boolean; user_id: string; require_2fa?: boolean }>(
      '/api/auth/verify-2fa',
      { method: 'POST', body: JSON.stringify({ user_id: userId, totp_code: totpCode }) }
    )
    if ('access_token' in body) {
      this.accessToken = body.access_token
      this.refreshToken = body.refresh_token
      await db.saveAuth({ access_token: body.access_token, refresh_token: body.refresh_token, user: body.user })
    }
    return body
  }

  async getMe(): Promise<User> {
    return this.request('/api/auth/me')
  }

  async logout(): Promise<void> {
    this.accessToken = null
    this.refreshToken = null
    await db.clearAuth()
  }

  // ─── 2FA ───
  async setup2fa(): Promise<{ secret: string; qr_code_url: string }> {
    return this.request('/api/auth/2fa/setup', { method: 'POST' })
  }

  async verify2faSetup(code: string): Promise<{ success: boolean }> {
    return this.request('/api/auth/2fa/verify-setup', { method: 'POST', body: JSON.stringify({ code }) })
  }

  async enable2fa(code: string): Promise<{ success: boolean; backup_codes?: string[] }> {
    return this.request('/api/auth/2fa/enable', { method: 'POST', body: JSON.stringify({ code }) })
  }

  // ─── Chats ───
  async getChats(): Promise<Chat[]> {
    return this.request('/api/chats')
  }

  async createChat(isGroup: boolean, name: string, participants: string[]): Promise<Chat> {
    return this.request('/api/chats', { method: 'POST', body: JSON.stringify({ is_group: isGroup, name, participants }) })
  }

  // ─── Messages ───
  async getMessages(chatId: string, limit = 50, cursor?: string): Promise<{ messages: Message[]; has_more: boolean; next_cursor: string }> {
    const params = new URLSearchParams({ limit: String(limit) })
    if (cursor) params.set('cursor', cursor)
    return this.request(`/api/chats/${chatId}/messages?${params}`)
  }

  async sendMessage(chatId: string, content: string, contentType = 'text', fileMetadataId?: string, topicId?: string, threadId?: string): Promise<Message> {
    return this.request('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ chat_id: chatId, content, content_type: contentType, file_metadata_id: fileMetadataId, topic_id: topicId, thread_id: threadId }),
    })
  }

  // ─── Channels ───
  async getChannels(): Promise<Channel[]> {
    return this.request('/api/channels')
  }

  async searchChannels(q: string): Promise<Channel[]> {
    return this.request(`/api/channels/search?q=${encodeURIComponent(q)}`)
  }

  async subscribeChannel(channelId: string): Promise<{ success: boolean; status: string }> {
    return this.request(`/api/channels/${channelId}/subscribe`, { method: 'POST' })
  }

  async unsubscribeChannel(channelId: string): Promise<{ success: boolean }> {
    return this.request(`/api/channels/${channelId}/unsubscribe`, { method: 'POST' })
  }

  async getChannelMessages(channelId: string, limit = 50, offset?: number): Promise<Message[]> {
    const params = new URLSearchParams({ limit: String(limit) })
    if (offset !== undefined) params.set('offset', String(offset))
    return this.request(`/api/channels/${channelId}/messages?${params}`)
  }

  // ─── Files ───
  async uploadFile(chatId: string, file: File): Promise<FileMeta> {
    const formData = new FormData()
    formData.append('file', file)
    const response = await fetch(`${API_BASE}/api/files/upload-chat/${chatId}`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: formData,
    })
    if (!response.ok) throw new Error(`Upload failed: ${response.status}`)
    return response.json()
  }

  async downloadFile(fileId: string): Promise<Blob> {
    const response = await fetch(`${API_BASE}/api/files/${fileId}`, {
      headers: this.authHeaders(),
    })
    if (!response.ok) throw new Error(`Download failed: ${response.status}`)
    return response.blob()
  }

  // ─── Unread ───
  async getUnreadCounts(): Promise<{ chat_id: string; count: number }[]> {
    return this.request('/api/unread')
  }

  async markRead(chatId: string): Promise<void> {
    return this.request(`/api/chats/${chatId}/read`, { method: 'POST' })
  }

  // ─── Typing ───
  async sendTyping(chatId: string): Promise<void> {
    return this.request('/api/typing', { method: 'POST', body: JSON.stringify({ chat_id: chatId }) })
  }

  // ─── Push ───
  async getVapidPublicKey(): Promise<{ public_key: string | null }> {
    return this.request('/api/push/vapid-public-key')
  }

  async subscribePush(endpoint: string, p256dh: string, authSecret: string): Promise<{ success: boolean }> {
    return this.request('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint, p256dh, auth_secret: authSecret }),
    })
  }

  // ─── Retry Queue: send pending messages ───
  async sendPendingMessage(pending: PendingMessage): Promise<Message | null> {
    try {
      const msg = await this.sendMessage(
        pending.chat_id,
        pending.encrypted_content,
        pending.content_type,
        pending.file_metadata_id ?? undefined,
        pending.topic_id ?? undefined,
        pending.thread_id ?? undefined
      )
      return msg
    } catch {
      return null
    }
  }
}

export const api = new ApiClient()

// ─── SSE Connection ───
export class SseConnection {
  private eventSource: EventSource | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private onMessage: (event: SseEvent) => void
  private onConnected: () => void
  private onDisconnected: () => void

  constructor(onMessage: (event: SseEvent) => void, onConnected: () => void, onDisconnected: () => void) {
    this.onMessage = onMessage
    this.onConnected = onConnected
    this.onDisconnected = onDisconnected
  }

  connect(token: string) {
    this.disconnect()
    const url = `${API_BASE}/api/sse/connect`
    // EventSource doesn't support custom headers, so we use the token as query param
    // Server should accept ?token= as alternative to Authorization header
    // Since our server uses Authorization header, we need a workaround.
    // For now, we'll use a fetch-based SSE approach that supports headers.
    this.connectWithFetch(token)
  }

  private async connectWithFetch(token: string) {
    try {
      const response = await fetch(`${API_BASE}/api/sse/connect`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      })
      if (!response.ok) {
        this.scheduleReconnect(token)
        return
      }

      await db.updateAuthField('sse_connected', true)
      this.onConnected()

      const reader = response.body?.getReader()
      if (!reader) {
        this.scheduleReconnect(token)
        return
      }

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            try {
              const event = JSON.parse(data) as SseEvent
              this.onMessage(event)
            } catch {
              // Ignore parse errors
            }
          }
        }
      }
    } catch {
      // Connection error
    }

    await db.updateAuthField('sse_connected', false)
    this.onDisconnected()
    this.scheduleReconnect(token)
  }

  private scheduleReconnect(token: string) {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      const tokens = { access: null as string | null, refresh: null as string | null }
      // Get fresh token from DB
      db.getAuth().then(auth => {
        if (auth?.access_token) {
          this.connect(auth.access_token)
        }
      })
    }, 3000)
  }

  disconnect() {
    this.reconnectTimer && clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }
}
