<template>
  <v-app>
    <!-- Offline banner -->
    <v-banner v-if="!networkStore.isOnline" color="warning" sticky>
      <template v-slot:text>
        No internet connection. Messages will be sent when you're back online.
      </template>
    </v-banner>

    <!-- Loading overlay -->
    <v-overlay v-if="loading" model-value class="align-center justify-center" persistent>
      <v-progress-circular indeterminate size="64" />
    </v-overlay>

    <router-view v-else />
  </v-app>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/features/auth/stores/auth.store'
import { useDbStore } from '@/core/db/stores/db.store'
import { useNetworkStore } from '@/core/network/stores/network.store'
import { useChatStore } from '@/features/chat/stores/chat.store'
import { useChannelStore } from '@/features/channel/stores/channel.store'
import { useRouter } from 'vue-router'

const authStore = useAuthStore()
const dbStore = useDbStore()
const networkStore = useNetworkStore()
const chatStore = useChatStore()
const channelStore = useChannelStore()
const router = useRouter()
const loading = ref(true)

onMounted(async () => {
  // Сначала инициализируем базу данных
  await dbStore.init()
  
  // Восстанавливаем аутентификацию
  await authStore.init()
  
  if (authStore.isAuthenticated) {
    // Инициализируем остальные stores
    await Promise.all([
      chatStore.init(),
      channelStore.init(),
      networkStore.init()
    ])
    // Запускаем интервал повторной отправки сообщений
    // (можно запустить один раз, но лучше установить интервал)
    // Пока просто вызовем один раз, интервал будет установлен внутри chat store?
    // Временно оставим как есть.
  }
  
  loading.value = false
  
  if (authStore.isAuthenticated) {
    router.replace('/chat')
  } else {
    router.replace('/login')
  }
})
</script>
