import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/api/client'
import * as db from '@/db'
import type { User, Chat, Message, Channel, PendingMessage, SseEvent, SseMessageEvent, SseTypingEvent, SseChannelMessageEvent } from '@/types'
import { SseConnection } from '@/api/client'

export const useAppStore = defineStore('app', () => {
  // ─── State ───
  const user = ref<User | null>(null)
  const isAuthenticated = ref(false)
  const isOnline = ref(navigator.onLine)
  const sseConnected = ref(false)
  const is2faSetup = ref(false)

  const chats = ref<Chat[]>([])
  const channels = ref<Channel[]>([])
  const activeChatId = ref<string | null>(null)
  const activeChannelId = ref<string | null>(null)

  const messages = ref<Map<string, Message[]>>(new Map())
  const channelMessages = ref<Map<string, Message[]>>(new Map())

  const typingUsers = ref<Map<string, Set<string>>>(new Map()) // chatId -> Set<userId>

  // ─── Computed ───
  const activeChat = computed(() => {
    if (activeChatId.value) return chats.value.find(c => c.id === activeChatId.value)
    if (activeChannelId.value) return channels.value.find(c => c.id === activeChannelId.value)
    return null
  })

  const activeMessages = computed(() => {
    if (activeChatId.value) return messages.value.get(activeChatId.value) || []
    if (activeChannelId.value) return channelMessages.value.get(activeChannelId.value) || []
    return []
  })

  // ─── SSE ───
  let sse: SseConnection | null = null

  function startSse() {
    if (sse) sse.disconnect()
    sse = new SseConnection(
      (event: SseEvent) => handleSseEvent(event),
      () => { sseConnected.value = true },
      () => { sseConnected.value = false }
    )
    api.getTokens().then(tokens => {
      if (tokens.access) sse?.connect(tokens.access)
    })
  }

  function stopSse() {
    sse?.disconnect()
    sse = null
    sseConnected.value = false
  }

  async function handleSseEvent(event: SseEvent) {
    switch (event.type) {
      case 'new_message': {
        const msgEvent = event as SseMessageEvent
        // Remove local pending message with same content
        const chatMsgs = messages.value.get(msgEvent.chat_id) || []
        const localIdx = chatMsgs.findIndex(m => m.local_pending && m.encrypted_content === msgEvent.data.encrypted_content)
        if (localIdx >= 0) {
          chatMsgs.splice(localIdx, 1)
          messages.value.set(msgEvent.chat_id, chatMsgs)
        }
        // Add server message
        const fullMsg: Message = {
          id: msgEvent.data.id,
          chat_id: msgEvent.chat_id,
          sender_id: msgEvent.data.sender_id || '',
          encrypted_content: msgEvent.data.encrypted_content,
          content_type: msgEvent.data.content_type || 'text',
          file_metadata_id: msgEvent.data.file_metadata_id || null,
          status: 'sent',
          edited: msgEvent.data.edited || false,
          deleted: msgEvent.data.deleted || false,
          created_at: msgEvent.data.created_at,
          edited_at: null,
          topic_id: null,
          thread_id: null,
        }
        await db.saveMessage(fullMsg)
        const chatMessages = messages.value.get(msgEvent.chat_id) || []
        // Avoid duplicates
        if (!chatMessages.find(m => m.id === fullMsg.id)) {
          chatMessages.push(fullMsg)
          messages.value.set(msgEvent.chat_id, chatMessages)
        }
        // Update chat unread
        const chat = chats.value.find(c => c.id === msgEvent.chat_id)
        if (chat && chat.id !== activeChatId.value) {
          chat.unread_count = (chat.unread_count || 0) + 1
          chat.last_message = fullMsg
        }
        break
      }
      case 'typing': {
        const typingEvent = event as SseTypingEvent
        let users = typingUsers.value.get(typingEvent.chat_id)
        if (!users) { users = new Set(); typingUsers.value.set(typingEvent.chat_id, users) }
        users.add(typingEvent.user_id)
        typingUsers.value = new Map(typingUsers.value)
        // Auto-clear after 3s
        setTimeout(() => {
          const u = typingUsers.value.get(typingEvent.chat_id)
          if (u) { u.delete(typingEvent.user_id); typingUsers.value.set(typingEvent.chat_id, new Set(u)) }
        }, 3000)
        break
      }
      case 'channel_message': {
        const chEvent = event as SseChannelMessageEvent
        const msg: Message = {
          id: chEvent.data.id,
          chat_id: '',
          sender_id: '',
          encrypted_content: chEvent.data.encrypted_content,
          content_type: chEvent.data.content_type,
          file_metadata_id: null,
          status: 'sent',
          edited: false,
          deleted: false,
          created_at: chEvent.data.created_at,
          edited_at: null,
          topic_id: null,
          thread_id: null,
        }
        await db.saveMessage(msg)
        const chMsgs = channelMessages.value.get(chEvent.channel_id) || []
        if (!chMsgs.find(m => m.id === msg.id)) {
          chMsgs.push(msg)
          channelMessages.value.set(chEvent.channel_id, chMsgs)
        }
        break
      }
    }
  }

  // ─── Online/Offline ───
  window.addEventListener('online', () => { isOnline.value = true; retryPendingMessages() })
  window.addEventListener('offline', () => { isOnline.value = false })

  // ─── Retry Queue ───
  let retryInterval: ReturnType<typeof setInterval> | null = null

  async function retryPendingMessages() {
    if (!isOnline.value) return
    const pending = await db.getPendingMessages()
    const now = Date.now()
    for (const msg of pending) {
      // Max 5 retries, backoff: 5s, 15s, 45s, 135s, 405s
      if (msg.retry_count >= 5) continue
      const backoff = Math.pow(3, msg.retry_count) * 5000
      if (now - msg.last_attempt < backoff) continue

      const sent = await api.sendPendingMessage(msg)
      if (sent) {
        await db.saveMessage(sent)
        await db.removePendingMessage(msg.id)
        // Update local messages: replace pending
        const chatMsgs = messages.value.get(msg.chat_id) || []
        const idx = chatMsgs.findIndex(m => m.id === msg.id)
        if (idx >= 0) {
          chatMsgs.splice(idx, 1, sent)
          messages.value.set(msg.chat_id, chatMsgs)
        }
      } else {
        await db.updatePendingRetry(msg.id, msg.retry_count + 1, now)
      }
    }
  }

  // Start retry interval
  retryInterval = setInterval(retryPendingMessages, 10000)

  // ─── Actions ───
  async function init() {
    const auth = await db.getAuth()
    if (auth?.access_token) {
      isAuthenticated.value = true
      // Always fetch fresh user data from server — is_admin can change
      try {
        const freshUser = await api.getMe()
        user.value = freshUser
        // Update cached user with fresh data
        await db.saveAuth({ ...auth, user: freshUser })
      } catch {
        // API error — fall back to cached user
        user.value = auth.user
      }
      await loadChats()
      startSse()
      retryPendingMessages()
    }
  }

  async function loadChats() {
    try {
      const [fetchedChats, unreadCounts] = await Promise.all([
        api.getChats(),
        api.getUnreadCounts(),
      ])
      // Merge unread counts
      const unreadMap = new Map(unreadCounts.map(u => [u.chat_id, u.count]))
      for (const chat of fetchedChats) {
        chat.unread_count = unreadMap.get(chat.id) || 0
      }
      // Replace entire chat cache with server data (removes stale/duplicate entries)
      await db.syncChats(fetchedChats)
      chats.value = fetchedChats
    } catch {
      // Network error — use cached chats (offline-first)
      chats.value = await db.getAllChats()
    }

    // Load channels — same approach
    try {
      const fetchedChannels = await api.getChannels()
      await db.syncChannels(fetchedChannels)
      channels.value = fetchedChannels
    } catch {
      channels.value = await db.getAllChannels()
    }
  }

  async function openChat(chatId: string) {
    activeChatId.value = chatId
    activeChannelId.value = null
    await api.markRead(chatId)
    await db.updateChatUnread(chatId, 0)
    const chat = chats.value.find(c => c.id === chatId)
    if (chat) chat.unread_count = 0

    // Fetch from server
    let serverMsgs: Message[] = []
    try {
      const result = await api.getMessages(chatId, 50)
      serverMsgs = result.messages
      // Save to IndexedDB for offline access
      await db.saveMessages(serverMsgs)
    } catch {
      // Use cached messages from IndexedDB
      serverMsgs = await db.getMessagesByChat(chatId, 50)
    }

    // Add pending messages (not yet sent to server)
    const pending = await db.getPendingByChat(chatId)
    const pendingMsgs = pending.map(p => ({
      id: p.id,
      chat_id: p.chat_id,
      sender_id: '',
      encrypted_content: p.encrypted_content,
      content_type: p.content_type,
      file_metadata_id: p.file_metadata_id,
      status: 'pending',
      edited: false,
      deleted: false,
      created_at: p.created_at,
      edited_at: null,
      topic_id: p.topic_id,
      thread_id: p.thread_id,
      local_pending: true,
    } as Message))

    // Merge: server messages + pending (deduplicate by id)
    const serverIds = new Set(serverMsgs.map(m => m.id))
    const uniquePending = pendingMsgs.filter(p => !serverIds.has(p.id))
    const allMsgs = [...serverMsgs, ...uniquePending]
    allMsgs.sort((a, b) => a.created_at.localeCompare(b.created_at))
    messages.value.set(chatId, allMsgs)
  }

  async function openChannel(channelId: string) {
    activeChannelId.value = channelId
    activeChatId.value = null

    const dbMsgs = await db.getMessagesByChat(channelId, 50)
    channelMessages.value.set(channelId, dbMsgs)

    try {
      const serverMsgs = await api.getChannelMessages(channelId, 50)
      await db.saveMessages(serverMsgs)
      channelMessages.value.set(channelId, serverMsgs)
    } catch {
      // Use cached
    }
  }

  async function sendLocalMessage(chatId: string, content: string, contentType = 'text', topicId?: string, threadId?: string) {
    const localId = crypto.randomUUID()
    const pending: PendingMessage = {
      id: localId,
      chat_id: chatId,
      encrypted_content: content,
      content_type: contentType,
      file_metadata_id: null,
      topic_id: topicId || null,
      thread_id: threadId || null,
      created_at: new Date().toISOString(),
      retry_count: 0,
      last_attempt: Date.now(),
    }

    const localMsg: Message = {
      id: localId,
      chat_id: chatId,
      sender_id: user.value?.id || '',
      encrypted_content: content,
      content_type: contentType,
      file_metadata_id: null,
      status: 'sending',
      edited: false,
      deleted: false,
      created_at: pending.created_at,
      edited_at: null,
      topic_id: topicId || null,
      thread_id: threadId || null,
      local_pending: true,
    }

    // Save to IndexedDB
    await db.addPendingMessage(pending)

    // Add to local messages
    const chatMsgs = messages.value.get(chatId) || []
    chatMsgs.push(localMsg)
    messages.value.set(chatId, chatMsgs)

    // Update sidebar: set last_message and unread for this chat
    const chat = chats.value.find(c => c.id === chatId)
    if (chat) {
      chat.last_message = localMsg
      chat.unread_count = chat.unread_count || 0
    }

    // Try to send immediately if online
    if (isOnline.value) {
      const sent = await api.sendPendingMessage(pending)
      if (sent) {
        await db.saveMessage(sent)
        await db.removePendingMessage(localId)
        const idx = chatMsgs.findIndex(m => m.id === localId)
        if (idx >= 0) chatMsgs.splice(idx, 1, sent)
        messages.value.set(chatId, chatMsgs)
      } else {
        await db.updatePendingRetry(localId, 1, Date.now())
        localMsg.local_failed = true
        localMsg.local_error = 'Send failed — will retry'
      }
    }

    // Send typing indicator
    if (isOnline.value) {
      api.sendTyping(chatId).catch(() => {})
    }
  }

  async function logout() {
    stopSse()
    if (retryInterval) clearInterval(retryInterval)
    await api.logout()
    user.value = null
    isAuthenticated.value = false
    chats.value = []
    channels.value = []
    messages.value.clear()
    channelMessages.value.clear()
    activeChatId.value = null
    activeChannelId.value = null
  }

  return {
    user, isAuthenticated, isOnline, sseConnected, is2faSetup,
    api, chats, channels, activeChatId, activeChannelId, activeChat, activeMessages,
    messages, channelMessages, typingUsers,
    init, loadChats, openChat, openChannel, sendLocalMessage, logout,
    startSse, stopSse, retryPendingMessages,
  }
})
