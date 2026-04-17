<script setup lang="ts">
import LoginForm from '@/components/LoginForm.vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import * as db from '@/db'
import { initializeKeys } from '@/crypto'
import { api } from '@/api/client'
import type { User } from '@/types'

const router = useRouter()
const appStore = useAppStore()

interface AuthData {
  user: User
  access_token: string
  refresh_token: string
}

async function saveAuth(data: AuthData) {
  await db.saveAuth({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user })
  api.setTokens(data.access_token, data.refresh_token)
  await initializeKeys()
}

function onLoginSuccess(data: AuthData) {
  appStore.user = data.user
  appStore.isAuthenticated = true
  appStore.startSse()
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
