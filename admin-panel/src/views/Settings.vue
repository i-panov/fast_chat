<template>
  <div>
    <h1 class="text-h4 mb-6">Settings</h1>

    <v-row>
      <v-col cols="12" md="6">
        <v-card>
          <v-card-title class="d-flex align-center">
            <v-icon start>mdi-information</v-icon>
            Server Information
          </v-card-title>
          <v-divider />
          <v-card-text>
            <v-list density="compact">
              <v-list-item>
                <v-list-item-title>Version</v-list-item-title>
                <template #append>
                  <v-chip size="small">{{ health.version || '-' }}</v-chip>
                </template>
              </v-list-item>
              <v-list-item>
                <v-list-item-title>Status</v-list-item-title>
                <template #append>
                  <v-chip size="small" :color="health.status === 'healthy' ? 'success' : 'error'">
                    {{ health.status || 'Unknown' }}
                  </v-chip>
                </template>
              </v-list-item>
              <v-list-item>
                <v-list-item-title>Uptime</v-list-item-title>
                <template #append>
                  <span class="text-body-2">{{ formatUptime(health.uptime_seconds) }}</span>
                </template>
              </v-list-item>
            </v-list>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="6">
        <v-card>
          <v-card-title class="d-flex align-center">
            <v-icon start>mdi-database</v-icon>
            Database Stats
          </v-card-title>
          <v-divider />
          <v-card-text>
            <v-list density="compact">
              <v-list-item>
                <v-list-item-title>Total Users</v-list-item-title>
                <template #append>
                  <span class="text-body-2">{{ stats.total_users }}</span>
                </template>
              </v-list-item>
              <v-list-item>
                <v-list-item-title>Total Chats</v-list-item-title>
                <template #append>
                  <span class="text-body-2">{{ stats.total_chats }}</span>
                </template>
              </v-list-item>
              <v-list-item>
                <v-list-item-title>Messages</v-list-item-title>
                <template #append>
                  <span class="text-body-2">{{ stats.total_messages }}</span>
                </template>
              </v-list-item>
              <v-list-item>
                <v-list-item-title>Active Calls</v-list-item-title>
                <template #append>
                  <span class="text-body-2">{{ stats.active_calls }}</span>
                </template>
              </v-list-item>
            </v-list>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-row class="mt-4">
      <v-col cols="12">
        <v-card>
          <v-card-title class="d-flex align-center">
            <v-icon start>mdi-cog</v-icon>
            Configuration
          </v-card-title>
          <v-divider />
          <v-card-text>
            <v-list density="compact">
              <v-list-item>
                <v-list-item-title>REST API URL</v-list-item-title>
                <template #append>
                  <span class="text-body-2 font-monospace">{{ apiHost }}</span>
                </template>
              </v-list-item>
              <v-list-item>
                <v-list-item-title>gRPC Server URL</v-list-item-title>
                <template #append>
                  <span class="text-body-2 font-monospace">{{ grpcHost }}</span>
                </template>
              </v-list-item>
              <v-list-item>
                <v-list-item-title>Auth Token</v-list-item-title>
                <template #append>
                  <v-btn size="small" variant="tonal" color="error" @click="clearToken">
                    Clear Token
                  </v-btn>
                </template>
              </v-list-item>
            </v-list>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-btn @click="refreshData" class="mt-4" prepend-icon="mdi-refresh">
      Refresh Data
    </v-btn>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { serverApi } from '@/api/serverApi'

const router = useRouter()

const stats = ref({
  total_users: 0,
  total_chats: 0,
  total_messages: 0,
  active_calls: 0,
  uptime_seconds: 0,
})

const health = ref({
  status: '',
  version: '',
  uptime_seconds: 0,
  active_calls: 0,
})

const apiHost = window.location.origin
const grpcHost = import.meta.env.VITE_GRPC_URL || 'http://localhost:50051'

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

async function refreshData() {
  try {
    const [statsData, healthData] = await Promise.all([
      serverApi.stats(),
      serverApi.health(),
    ])
    stats.value = statsData
    health.value = healthData
  } catch (err) {
    console.error('Failed to refresh data:', err)
  }
}

function clearToken() {
  localStorage.removeItem('admin_token')
  router.push('/login')
}

onMounted(() => {
  refreshData()
})
</script>
