<script setup lang="ts">
import LoginForm from '@/components/LoginForm.vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import * as db from '@/db'

const router = useRouter()
const appStore = useAppStore()

async function saveAuth(data: { user: any; access_token: string; refresh_token: string }) {
  await db.saveAuth({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user })
}

function onLoginSuccess(data: { user: any; access_token: string; refresh_token: string }) {
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
    :save-auth="saveAuth"
    :on-login-success="onLoginSuccess"
  />
</template>
