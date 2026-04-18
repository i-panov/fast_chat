<template>
  <v-app>
    <!-- Offline banner -->
    <v-banner v-if="!networkStore.isOnline" color="warning" sticky>
      <template v-slot:text>
        No internet. Messages will be sent when you're back online.
        <v-chip size="x-small" class="ml-2">{{ pendingCount }} pending</v-chip>
      </template>
    </v-banner>

    <v-navigation-drawer v-model="drawer" :width="320" permanent>
      <!-- Header -->
      <v-list-item class="px-4 py-2" lines="two">
        <template v-slot:prepend>
          <v-avatar color="primary" size="40">
            <v-icon>mdi-account</v-icon>
          </v-avatar>
        </template>
        <v-list-item-title>{{ authStore.user?.username }}</v-list-item-title>
        <v-list-item-subtitle>
          <v-chip v-if="networkStore.isConnected" color="success" size="x-small" class="mr-1">Online</v-chip>
          <v-chip v-else color="grey" size="x-small" class="mr-1">Offline</v-chip>
        </v-list-item-subtitle>
        <template v-slot:append>
          <v-btn icon="mdi-logout" variant="text" size="small" @click="authStore.logout(); router.replace('/login')" />
        </template>
      </v-list-item>

      <v-divider />

      <!-- Search -->
      <v-text-field
        v-model="search"
        prepend-inner-icon="mdi-magnify"
        placeholder="Search users or chats..."
        variant="plain"
        density="compact"
        hide-details
        class="px-3"
        @update:model-value="onSearchInput"
      />

      <!-- Search results: users -->
      <v-list density="compact" nav v-if="searchResults.length > 0">
        <v-list-subheader>Users</v-list-subheader>
        <v-list-item
          v-for="user in searchResults"
          :key="user.id"
          @click="startChatWith(user)"
          lines="one"
        >
          <template v-slot:prepend>
            <v-avatar color="grey" size="36">
              <v-icon>mdi-account</v-icon>
            </v-avatar>
          </template>
          <v-list-item-title>{{ user.username }}</v-list-item-title>
          <v-list-item-subtitle>{{ user.email }}</v-list-item-subtitle>
          <template v-slot:append>
            <v-icon icon="mdi-plus" color="primary" />
          </template>
        </v-list-item>
      </v-list>

      <!-- Chat list -->
      <v-list density="compact" nav v-if="searchResults.length === 0">
        <v-menu
          v-for="chat in filteredChats"
          :key="chat.id"
          v-model="contextMenus[chat.id]"
          :close-on-content-click="true"
          :offset="5"
        >
          <template v-slot:activator="{ props }">
            <v-list-item
              v-bind="props"
              :active="chatStore.activeChatId === chat.id"
              @click="selectChat(chat.id)"
              @contextmenu.prevent="openContextMenu(chat.id)"
              lines="two"
            >
              <template v-slot:prepend>
                <v-avatar :color="chat.is_group ? 'teal' : 'blue'" size="36">
                  <v-icon>{{ chat.is_group ? 'mdi-account-group' : 'mdi-account' }}</v-icon>
                </v-avatar>
              </template>
              <v-list-item-title>{{ getChatDisplayName(chat) }}</v-list-item-title>
              <v-list-item-subtitle>
                <template v-if="chat.last_message">
                  {{ chat.last_message.encrypted_content.substring(0, 30) }}...
                </template>
                <template v-else-if="chat.unread_count === 0">No messages yet</template>
              </v-list-item-subtitle>
              <template v-slot:append>
                <v-chip v-if="chat.unread_count" color="primary" size="x-small">
                  {{ chat.unread_count }}
                </v-chip>
              </template>
            </v-list-item>
          </template>

          <v-list density="compact" min-width="180">
            <v-list-item @click="confirmDeleteChat(chat.id)" class="text-red">
              <template v-slot:prepend>
                <v-icon icon="mdi-delete" color="red" />
              </template>
              <v-list-item-title>Удалить чат</v-list-item-title>
            </v-list-item>
          </v-list>
        </v-menu>
      </v-list>
    </v-navigation-drawer>

    <v-main>
      <!-- No chat selected -->
      <div v-if="!chatStore.activeChatId" class="fill-height d-flex align-center justify-center text-grey">
        <div class="text-center">
          <v-icon size="64">mdi-message-text-outline</v-icon>
          <p class="mt-4">Select a chat to start messaging</p>
        </div>
      </div>

      <!-- Chat view -->
      <div v-else class="fill-height d-flex flex-column">
        <!-- Chat header -->
        <v-app-bar elevation="1" density="compact">
          <v-app-bar-nav-icon @click="drawer = !drawer" />
          <v-toolbar-title>{{ activeChat ? getChatDisplayName(activeChat) : 'Chat' }}</v-toolbar-title>
          <v-spacer />
          <v-chip v-if="typingText" color="info" size="small" class="mr-2">{{ typingText }}</v-chip>
          <v-btn v-if="authStore.user?.is_admin" icon="mdi-shield-check" size="small" variant="text" @click="router.push('/admin')" title="Admin Panel" />
        </v-app-bar>

        <!-- Messages -->
        <v-sheet ref="messagesContainer" class="flex-grow-1 overflow-auto pa-4" style="background: #0a0a0a">
          <div v-if="chatStore.activeMessages.length === 0" class="text-center text-grey pa-8">
            No messages yet
          </div>
          <v-infinite-scroll v-else @load="loadMore" :empty-text="''">
            <template v-for="msg in chatStore.activeMessages" :key="msg.id">
              <!-- Pending/failed messages -->
              <div
                :class="['d-flex mb-2', msg.sender_id === authStore.user?.id ? 'justify-end' : 'justify-start']"
              >
                <v-card
                  :color="msg.local_pending ? 'grey-darken-3' : (msg.local_failed ? 'red-darken-4' : (msg.sender_id === authStore.user?.id ? 'primary-darken-2' : 'surface'))"
                  :max-width="400"
                  :elevation="1"
                  class="px-3 py-2"
                >
                  <div class="text-body-2 text-break">{{ getMessageContent(msg) }}</div>
                  <div class="d-flex align-center justify-end mt-1">
                    <span class="text-caption text-grey">{{ formatTime(msg.created_at) }}</span>
                    <v-icon v-if="msg.local_failed" icon="mdi-alert-circle" size="14" color="error" class="ml-1" />
                    <v-icon v-else-if="msg.local_pending" icon="mdi-clock-outline" size="14" color="grey" class="ml-1" />
                    <v-icon v-else-if="msg.sender_id === authStore.user?.id" icon="mdi-check-all" size="14" color="grey" class="ml-1" />
                  </div>
                </v-card>
              </div>
            </template>
          </v-infinite-scroll>
        </v-sheet>

        <!-- Message input -->
        <v-sheet class="pa-2" border>
          <v-form @submit.prevent="sendMessage" class="d-flex align-center ga-2">
          <v-btn icon="mdi-attachment" variant="text" @click="fileInput && fileInput.click()" />
          <input ref="fileInput" type="file" style="display: none" @change="onFileSelect" />
          <v-text-field
            v-model="messageText"
            placeholder="Type a message..."
            density="compact"
            variant="plain"
            hide-details
            :disabled="sending"
            @keydown.enter.exact.prevent="sendMessage"
          />
          <v-btn
            icon="mdi-send"
            color="primary"
            variant="flat"
            :loading="sending"
            :disabled="(!messageText.trim() && !selectedFile) || sending"
            type="submit"
          />
        </v-form>
        <div v-if="selectedFile" class="mt-2">
          <v-chip closable @click:close="selectedFile = null">{{ selectedFile.name }}</v-chip>
        </div>
        </v-sheet>
      </div>
    </v-main>
  </v-app>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/features/auth/stores/auth.store'
import { useChatStore } from '@/features/chat/stores/chat.store'
import { useNetworkStore } from '@/core/network/stores/network.store'
import { chatApi } from '@/features/chat/api/chat-api'
import { fileApi } from '@/core/api/file-api'
import type { FileMeta, Message, User } from '@/types'

type SearchUser = Pick<User, 'id' | 'username' | 'email' | 'is_admin'>

const authStore = useAuthStore()
const chatStore = useChatStore()
const networkStore = useNetworkStore()
const router = useRouter()

function getMessageContent(msg: Message): string {
  return msg.encrypted_content
}

const drawer = ref(true)
const search = ref('')
const searchResults = ref<SearchUser[]>([])
const isCreatingChat = ref(false)
const contextMenus = ref<Record<string, boolean>>({})
let searchTimeout: ReturnType<typeof setTimeout> | null = null

function openContextMenu(chatId: string) {
  contextMenus.value[chatId] = true
}

async function confirmDeleteChat(chatId: string) {
  // Close menu
  contextMenus.value[chatId] = false
  if (!confirm('Удалить чат? История сообщений будет потеряна.')) return
  await chatStore.deleteChat(chatId)
}

function onSearchInput() {
  if (searchTimeout) clearTimeout(searchTimeout)
  searchResults.value = []
  if (search.value.length < 2) return
  searchTimeout = setTimeout(async () => {
    try {
      const accessToken = authStore.accessToken
      if (!accessToken) return
      const url = `/api/users/search?q=${encodeURIComponent(search.value)}&limit=10`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
      if (!res.ok) return
      const users = await res.json()
      // Filter out users already in chats
      const existingUsernames = new Set(chatStore.chats.map(c => c.name))
      searchResults.value = users.filter((u: SearchUser) => !existingUsernames.has(u.username) && u.id !== authStore.user?.id)
    } catch (e) {
      console.log('[search] error:', e)
      searchResults.value = []
    }
  }, 400)
}

async function startChatWith(user: { id: string; username: string }) {
  if (isCreatingChat.value) return
  isCreatingChat.value = true
  if (searchTimeout) clearTimeout(searchTimeout)

  try {
    const existingChat = chatStore.chats.find(c => c.name === user.username)
    if (existingChat) {
      selectChat(existingChat.id)
      search.value = ''
      searchResults.value = []
      return
    }
    const accessToken = authStore.accessToken
    if (!accessToken) return
    const res = await fetch('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ is_group: false, name: user.username, participants: [user.id] }),
    })
    if (!res.ok) return
    const chat = await res.json()
    chatStore.chats.unshift(chat)
    await chatStore.openChat(chat.id)
    search.value = ''
    searchResults.value = []
  } catch (e: unknown) {
    console.error('Failed to create chat:', e)
  } finally {
    isCreatingChat.value = false
  }
}

const messageText = ref('')
const sending = ref(false)
const messagesContainer = ref<HTMLElement | null>(null)
const messagesCursor = ref<string | null>(null)
const messagesLoading = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const selectedFile = ref<File | null>(null)
const selectedFileMeta = ref<FileMeta | null>(null)

const pendingCount = computed(() => {
  let count = 0
  for (const [_chatId, msgs] of chatStore.messages) {
    count += msgs.filter((m: Message) => m.local_pending).length
  }
  return count
})

async function onFileSelect(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  try {
    const meta = await fileApi.uploadFile(chatStore.activeChatId!, file)
    selectedFile.value = file
    selectedFileMeta.value = meta
  } catch (e) {
    console.error('Upload failed:', e)
  }
}

const filteredChats = computed(() => {
  if (!search.value) return chatStore.chats
  const q = search.value.toLowerCase()
  return chatStore.chats.filter(c => (c.name || '').toLowerCase().includes(q))
})

const activeChat = computed(() => {
  if (!chatStore.activeChatId) return null
  return chatStore.chats.find(c => c.id === chatStore.activeChatId)
})

function getChatDisplayName(chat: { name: string | null, is_group: boolean, participants: string[] }): string {
  if (chat.name) return chat.name
  if (chat.is_group) return 'Group Chat'
  // For direct chats, show the other participant
  const otherParticipant = chat.participants.find(p => p !== authStore.user?.id)
  return otherParticipant || 'Chat'
}

const typingText = computed(() => {
  if (!chatStore.activeChatId) return ''
  const users = chatStore.typingUsers.get(chatStore.activeChatId)
  if (!users || users.size === 0) return ''
  return `${users.size} typing...`
})

function selectChat(chatId: string) {
  messagesCursor.value = null
  chatStore.openChat(chatId)
  nextTick(scrollToBottom)
}

function scrollToBottom() {
  const el = messagesContainer.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(() => chatStore.activeMessages.length, () => {
  nextTick(scrollToBottom)
})

async function sendMessage() {
  if ((!messageText.value.trim() && !selectedFile.value) || !chatStore.activeChatId) return
  const text = messageText.value.trim()
  messageText.value = ''
  const fileMeta = selectedFileMeta.value
  selectedFile.value = null
  selectedFileMeta.value = null
  sending.value = true
  try {
    await chatStore.sendMessage(chatStore.activeChatId, text, { contentType: 'text', fileMetadataId: fileMeta?.id })
    nextTick(scrollToBottom)
  } finally {
    sending.value = false
  }
}

async function loadMore({ done }: { done: (_status: 'empty' | 'ok' | 'error') => void }) {
  if (!chatStore.activeChatId || messagesLoading.value) {
    done('empty')
    return
  }

  messagesLoading.value = true
  try {
    const result = await chatApi.getMessages(chatStore.activeChatId, messagesCursor.value ?? undefined, 50)
    const chatMsgs = chatStore.messages.get(chatStore.activeChatId) || []

    // Add messages to the beginning (older messages)
    const newMsgs = result.messages.filter(m => !chatMsgs.find(existing => existing.id === m.id))
    if (newMsgs.length > 0) {
      chatMsgs.unshift(...newMsgs)
      chatStore.messages.set(chatStore.activeChatId, chatMsgs)
    }

    if (result.has_more && result.next_cursor) {
      messagesCursor.value = result.next_cursor
      done('ok')
    } else {
      done('empty')
    }
  } catch (err) {
    console.error('Failed to load more messages:', err)
    done('error')
  } finally {
    messagesLoading.value = false
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

onMounted(async () => {
  if (!authStore.isAuthenticated) { router.replace('/login'); return }
  // Open first chat if available
  if (chatStore.chats.length > 0 && !chatStore.activeChatId) {
    const chat = chatStore.chats.find(c => c.unread_count) || chatStore.chats[0]
    if (chat) selectChat(chat.id)
  }
})
</script>