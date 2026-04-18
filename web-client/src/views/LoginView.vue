<script setup lang="ts">
import LoginForm from '@/features/auth/components/LoginForm.vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/features/auth/stores/auth.store'
import { useNetworkStore } from '@/core/network/stores/network.store'
import { useChatStore } from '@/features/chat/stores/chat.store'
import { useChannelStore } from '@/features/channel/stores/channel.store'
import { useCryptoStore } from '@/core/crypto/stores/crypto.store'
import type { AuthResponse } from '@/features/auth/types'

const router = useRouter()
const authStore = useAuthStore()
const networkStore = useNetworkStore()
const chatStore = useChatStore()
const channelStore = useChannelStore()
const cryptoStore = useCryptoStore()

async function saveAuth(data: AuthResponse) {
  // Используем auth store для сохранения аутентификации
  await authStore.handleAuthResponse(data)
  // Инициализируем ключи (если нужно)
  await cryptoStore.init()
}

async function onLoginSuccess(_data: AuthResponse) {
  // Пользователь уже сохранён в auth store через saveAuth
  // Инициализируем остальные stores
  await Promise.all([
    chatStore.init(),
    channelStore.init(),
    networkStore.init()
  ])
  router.replace('/chat')
}
</script>

<template>
  <LoginForm
    app-title="Fast Chat"
    app-icon="mdi-message-text"
    api-prefix="/api"
    :save-auth="saveAuth"
    :on-login-success="onLoginSuccess"
  />
</template>
