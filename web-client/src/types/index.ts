export interface User {
  id: string
  username: string
  email: string
  is_admin: boolean
  totp_enabled: boolean
  require_2fa: boolean
  created_at: string
}

export interface AuthResponse {
  access_token: string
  refresh_token: string
  user: User
}

export interface Chat {
  id: string
  is_group: boolean
  name: string | null
  created_by: string
  is_favorites: boolean
  participants: string[]
  created_at: string
  unread_count?: number
  last_message?: Message
}

export interface Message {
  id: string
  chat_id: string
  sender_id: string
  encrypted_content: string
  content_type: string
  file_metadata_id: string | null
  status: string
  edited: boolean
  deleted: boolean
  created_at: string
  edited_at: string | null
  topic_id: string | null
  thread_id: string | null
  // Local fields (not from server)
  local_pending?: boolean
  local_failed?: boolean
  local_error?: string
}

export interface Channel {
  id: string
  owner_id: string
  title: string
  description: string | null
  username: string | null
  access_level: 'public' | 'private' | 'private_with_approval'
  avatar_url: string | null
  subscribers_count: number
  is_subscriber: boolean
  created_at: string
}

export interface FileMeta {
  id: string
  original_name: string
  mime_type: string | null
  size_bytes: number
  uploaded_at: string
}

export interface Topic {
  id: string
  chat_id: string
  name: string
  created_at: string
}

export interface Thread {
  id: string
  chat_id: string
  root_message_id: string
  reply_count: number
  created_at: string
}

// ─── SSE Events ───
export interface SseMessageEvent {
  type: 'new_message'
  chat_id: string
  data: Partial<Message> & { id: string }
}

export interface SseTypingEvent {
  type: 'typing'
  user_id: string
  chat_id: string
}

export interface SseChannelMessageEvent {
  type: 'channel_message'
  channel_id: string
  data: { id: string; encrypted_content: string; content_type: string; created_at: string }
}

export type SseEvent = SseMessageEvent | SseTypingEvent | SseChannelMessageEvent

// ─── Retry Queue ───
export interface PendingMessage {
  id: string        // local ID (uuid)
  chat_id: string
  encrypted_content: string
  content_type: string
  file_metadata_id: string | null
  topic_id: string | null
  thread_id: string | null
  created_at: string
  retry_count: number
  last_attempt: number  // timestamp
}
