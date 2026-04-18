<template>
  <v-app>
    <v-navigation-drawer v-model="drawer" :width="320" permanent>
      <v-list-item class="px-4 py-2" lines="two">
        <template v-slot:prepend>
          <v-avatar color="purple" size="40">
            <v-icon>mdi-broadcast</v-icon>
          </v-avatar>
        </template>
        <v-list-item-title>Channels</v-list-item-title>
        <v-list-item-subtitle>{{ channelStore.channels.length }} channels</v-list-item-subtitle>
        <template v-slot:append>
          <v-btn icon="mdi-arrow-left" variant="text" size="small" @click="router.replace('/chat')" />
        </template>
      </v-list-item>

      <v-divider />

      <v-text-field
        v-model="search"
        prepend-inner-icon="mdi-magnify"
        placeholder="Search channels..."
        variant="plain"
        density="compact"
        hide-details
        class="px-3"
      />

      <v-list density="compact" nav>
        <!-- My channels -->
        <v-list-subheader>My Channels</v-list-subheader>
        <v-list-item
          v-for="ch in myChannels"
          :key="ch.id"
          :active="channelStore.activeChannelId === ch.id"
          @click="openChannel(ch.id)"
          lines="two"
        >
          <template v-slot:prepend>
            <v-avatar color="purple" size="36">
              <v-icon>mdi-bullhorn</v-icon>
            </v-avatar>
          </template>
          <v-list-item-title>{{ ch.title }}</v-list-item-title>
          <v-list-item-subtitle>{{ ch.subscribers_count }} subscribers</v-list-item-subtitle>
        </v-list-item>

        <!-- Search results -->
        <template v-if="searchResults.length">
          <v-list-subheader>Search Results</v-list-subheader>
          <v-list-item
            v-for="ch in searchResults"
            :key="ch.id"
            lines="two"
          >
            <template v-slot:prepend>
              <v-avatar color="purple-darken-2" size="36">
                <v-icon>{{ ch.access_level === 'public' ? 'mdi-earth' : 'mdi-lock' }}</v-icon>
              </v-avatar>
            </template>
            <v-list-item-title>{{ ch.title }}</v-list-item-title>
            <v-list-item-subtitle>{{ ch.access_level }}</v-list-item-subtitle>
            <template v-slot:append>
              <v-btn
                v-if="!ch.is_subscriber"
                size="small"
                color="primary"
                :loading="subscribing === ch.id"
                @click="subscribe(ch.id)"
              >
                Join
              </v-btn>
              <v-chip v-else color="success" size="x-small">Joined</v-chip>
            </template>
          </v-list-item>
        </template>
      </v-list>
    </v-navigation-drawer>

    <v-main>
      <div v-if="!channelStore.activeChannelId" class="fill-height d-flex align-center justify-center text-grey">
        <div class="text-center">
          <v-icon size="64">mdi-bullhorn-outline</v-icon>
          <p class="mt-4">Select a channel to view</p>
        </div>
      </div>

      <div v-else class="fill-height d-flex flex-column">
        <v-app-bar elevation="1" density="compact">
          <v-app-bar-nav-icon @click="drawer = !drawer" />
          <v-toolbar-title>{{ activeChannel?.title }}</v-toolbar-title>
          <v-spacer />
          <v-chip size="small">{{ activeChannel?.subscribers_count }} subscribers</v-chip>
        </v-app-bar>

        <v-sheet class="flex-grow-1 overflow-auto pa-4" style="background: #0a0a0a">
          <div v-for="msg in channelStore.activeMessages" :key="msg.id" class="d-flex mb-2 justify-start">
            <v-card color="surface" max-width="500" elevation="1" class="px-3 py-2">
              <div class="text-body-2 text-break">{{ msg.encrypted_content }}</div>
              <div class="text-caption text-grey mt-1">{{ formatTime(msg.created_at) }}</div>
            </v-card>
          </div>
          <div v-if="!channelStore.activeMessages.length" class="text-center text-grey pa-8">
            No messages in this channel yet
          </div>
        </v-sheet>
      </div>
    </v-main>
  </v-app>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/features/auth/stores/auth.store'
import { useChannelStore } from '@/features/channel/stores/channel.store'
import { channelApi } from '@/features/channel/api/channel-api'
import type { Channel } from '@/types'

const authStore = useAuthStore()
const channelStore = useChannelStore()
const router = useRouter()

const drawer = ref(true)
const search = ref('')
const subscribing = ref<string | null>(null)

const myChannels = computed(() => channelStore.channels.filter(ch => ch.is_subscriber))
const searchResults = ref<Channel[]>([])

const activeChannel = computed(() => {
  if (!channelStore.activeChannelId) return null
  return channelStore.channels.find(c => c.id === channelStore.activeChannelId)
})

async function openChannel(id: string) {
  channelStore.openChannel(id)
}

async function subscribe(id: string) {
  subscribing.value = id
  try {
    await channelApi.subscribe({ channel_id: id })
    // Refresh channels
    await channelStore.loadChannels()
  } catch {
    // Show error
  } finally {
    subscribing.value = null
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// Search on typing
let searchTimeout: ReturnType<typeof setTimeout> | null = null
watch(search, async (q) => {
  if (searchTimeout) clearTimeout(searchTimeout)
  if (!q.trim()) { searchResults.value = []; return }
  searchTimeout = setTimeout(async () => {
    try {
      searchResults.value = await channelApi.searchChannels({ query: q })
    } catch { searchResults.value = [] }
  }, 300)
})

onMounted(() => {
  if (!authStore.isAuthenticated) { router.replace('/login'); return }
})
</script>