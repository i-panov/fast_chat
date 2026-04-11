<template>
  <v-app>
    <!-- Offline banner -->
    <v-banner v-if="!appStore.isOnline" color="warning" sticky>
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
        <v-list-item-title>{{ appStore.user?.username }}</v-list-item-title>
        <v-list-item-subtitle>
          <v-chip v-if="appStore.sseConnected" color="success" size="x-small" class="mr-1">Online</v-chip>
          <v-chip v-else color="grey" size="x-small" class="mr-1">Offline</v-chip>
        </v-list-item-subtitle>
        <template v-slot:append>
          <v-btn icon="mdi-logout" variant="text" size="small" @click="appStore.logout(); router.replace('/login')" />
        </template>
      </v-list-item>

      <v-divider />

      <!-- Search -->
      <v-text-field
        v-model="search"
        prepend-inner-icon="mdi-magnify"
        placeholder="Search chats..."
        variant="plain"
        density="compact"
        hide-details
        class="px-3"
      />

      <!-- Chat list -->
      <v-list density="compact" nav>
        <v-list-item
          v-for="chat in filteredChats"
          :key="chat.id"
          :active="appStore.activeChatId === chat.id"
          @click="selectChat(chat.id)"
          lines="two"
        >
          <template v-slot:prepend>
            <v-avatar :color="chat.is_group ? 'teal' : 'blue'" size="36">
              <v-icon>{{ chat.is_group ? 'mdi-account-group' : 'mdi-account' }}</v-icon>
            </v-avatar>
          </template>
          <v-list-item-title>{{ chat.name || 'Chat' }}</v-list-item-title>
          <v-list-item-subtitle>
            <template v-if="chat.last_message">
              {{ chat.last_message.encrypted_content.substring(0, 30) }}...
            </template>
            <template v-else>No messages yet</template>
          </v-list-item-subtitle>
          <template v-slot:append>
            <v-chip v-if="chat.unread_count" color="primary" size="x-small">
              {{ chat.unread_count }}
            </v-chip>
          </template>
        </v-list-item>
      </v-list>
    </v-navigation-drawer>

    <v-main>
      <!-- No chat selected -->
      <div v-if="!appStore.activeChatId" class="fill-height d-flex align-center justify-center text-grey">
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
          <v-toolbar-title>{{ activeChat?.name || 'Chat' }}</v-toolbar-title>
          <v-spacer />
          <v-chip v-if="typingText" color="info" size="small" class="mr-2">{{ typingText }}</v-chip>
        </v-app-bar>

        <!-- Messages -->
        <v-sheet ref="messagesContainer" class="flex-grow-1 overflow-auto pa-4" style="background: #0a0a0a">
          <v-infinite-scroll @load="loadMore" :empty-text="''">
            <template v-for="msg in appStore.activeMessages" :key="msg.id">
              <!-- Pending/failed messages -->
              <div
                :class="['d-flex mb-2', msg.sender_id === appStore.user?.id ? 'justify-end' : 'justify-start']"
              >
                <v-card
                  :color="msg.local_pending ? 'grey-darken-3' : (msg.local_failed ? 'red-darken-4' : (msg.sender_id === appStore.user?.id ? 'primary-darken-2' : 'surface'))"
                  :max-width="400"
                  :elevation="1"
                  class="px-3 py-2"
                >
                  <div class="text-body-2 text-break">{{ msg.encrypted_content }}</div>
                  <div class="d-flex align-center justify-end mt-1">
                    <span class="text-caption text-grey">{{ formatTime(msg.created_at) }}</span>
                    <v-icon v-if="msg.local_failed" icon="mdi-alert-circle" size="14" color="error" class="ml-1" />
                    <v-icon v-else-if="msg.local_pending" icon="mdi-clock-outline" size="14" color="grey" class="ml-1" />
                    <v-icon v-else-if="msg.sender_id === appStore.user?.id" icon="mdi-check-all" size="14" color="grey" class="ml-1" />
                  </div>
                </v-card>
              </div>
            </template>
            <template v-slot:empty>
              <div class="text-center text-grey pa-8">No messages yet</div>
            </template>
          </v-infinite-scroll>
        </v-sheet>

        <!-- Message input -->
        <v-sheet class="pa-2" border>
          <v-form @submit.prevent="sendMessage" class="d-flex align-center ga-2">
            <v-btn icon="mdi-attachment" variant="text" />
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
              :disabled="!messageText.trim()"
              type="submit"
            />
          </v-form>
        </v-sheet>
      </div>
    </v-main>
  </v-app>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import type { Chat, Message } from '@/types'

const appStore = useAppStore()
const router = useRouter()

const drawer = ref(true)
const search = ref('')
const messageText = ref('')
const sending = ref(false)
const messagesContainer = ref<HTMLElement | null>(null)

const pendingCount = computed(() => {
  let count = 0
  for (const msgs of appStore.messages.values()) {
    count += msgs.filter(m => m.local_pending).length
  }
  return count
})

const filteredChats = computed(() => {
  if (!search.value) return appStore.chats
  const q = search.value.toLowerCase()
  return appStore.chats.filter(c => (c.name || '').toLowerCase().includes(q))
})

const activeChat = computed(() => {
  if (!appStore.activeChatId) return null
  return appStore.chats.find(c => c.id === appStore.activeChatId)
})

const typingText = computed(() => {
  if (!appStore.activeChatId) return ''
  const users = appStore.typingUsers.get(appStore.activeChatId)
  if (!users || users.size === 0) return ''
  return `${users.size} typing...`
})

function selectChat(chatId: string) {
  appStore.openChat(chatId)
  nextTick(scrollToBottom)
}

function scrollToBottom() {
  const el = messagesContainer.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(() => appStore.activeMessages.length, () => {
  nextTick(scrollToBottom)
})

async function sendMessage() {
  if (!messageText.value.trim() || !appStore.activeChatId) return
  const text = messageText.value.trim()
  messageText.value = ''
  sending.value = true
  try {
    await appStore.sendLocalMessage(appStore.activeChatId, text)
    nextTick(scrollToBottom)
  } finally {
    sending.value = false
  }
}

async function loadMore({ done }: { done: (status: 'empty' | 'ok' | 'error') => void }) {
  if (!appStore.activeChatId) { done('empty'); return }
  // Load more messages from server (pagination)
  done('empty')
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

onMounted(async () => {
  if (!appStore.isAuthenticated) { router.replace('/login'); return }
  // Open first chat if available
  if (appStore.chats.length > 0 && !appStore.activeChatId) {
    const chat = appStore.chats.find(c => c.unread_count) || appStore.chats[0]
    if (chat) selectChat(chat.id)
  }
})
</script>
