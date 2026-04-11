<template>
  <v-app>
    <!-- Offline banner -->
    <v-banner v-if="!appStore.isOnline" color="warning" sticky>
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
import { useAppStore } from '@/stores/app'
import { useRouter } from 'vue-router'

const appStore = useAppStore()
const router = useRouter()
const loading = ref(true)

onMounted(async () => {
  await appStore.init()
  loading.value = false
  if (appStore.isAuthenticated) {
    router.replace('/chat')
  } else {
    router.replace('/login')
  }
})
</script>
