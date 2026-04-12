<template>
  <div>
    <h1 class="text-h4 mb-6">Dashboard</h1>

    <v-row>
      <v-col cols="12" sm="6" md="3">
        <v-card color="primary" variant="tonal">
          <v-card-text>
            <div class="d-flex align-center">
              <v-icon size="x-large" class="mr-3">mdi-account-multiple</v-icon>
              <div>
                <div class="text-h5">{{ stats.total_users }}</div>
                <div class="text-caption">Total Users</div>
              </div>
            </div>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" sm="6" md="3">
        <v-card color="success" variant="tonal">
          <v-card-text>
            <div class="d-flex align-center">
              <v-icon size="x-large" class="mr-3">mdi-forum</v-icon>
              <div>
                <div class="text-h5">{{ stats.total_chats }}</div>
                <div class="text-caption">Total Chats</div>
              </div>
            </div>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" sm="6" md="3">
        <v-card color="warning" variant="tonal">
          <v-card-text>
            <div class="d-flex align-center">
              <v-icon size="x-large" class="mr-3">mdi-message-text</v-icon>
              <div>
                <div class="text-h5">{{ stats.total_messages }}</div>
                <div class="text-caption">Messages</div>
              </div>
            </div>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" sm="6" md="3">
        <v-card color="accent" variant="tonal">
          <v-card-text>
            <div class="d-flex align-center">
              <v-icon size="x-large" class="mr-3">mdi-phone</v-icon>
              <div>
                <div class="text-h5">{{ stats.active_calls }}</div>
                <div class="text-caption">Active Calls</div>
              </div>
            </div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-row class="mt-4">
      <v-col cols="12" md="6">
        <v-card>
          <v-card-title class="d-flex align-center">
            <v-icon start>mdi-server</v-icon>
            Server Health
          </v-card-title>
          <v-divider />
          <v-card-text>
            <v-list density="compact">
              <v-list-item>
                <template #prepend>
                  <v-icon :color="healthStatus.color">mdi-circle</v-icon>
                </template>
                <v-list-item-title>Status</v-list-item-title>
                <template #append>
                  <v-chip size="small" :color="healthStatus.color">
                    {{ health.status || 'Unknown' }}
                  </v-chip>
                </template>
              </v-list-item>
              <v-list-item>
                <v-list-item-title>Version</v-list-item-title>
                <template #append>
                  <span class="text-body-2">{{ health.version || '-' }}</span>
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
            <v-icon start>mdi-clock-fast</v-icon>
            Quick Actions
          </v-card-title>
          <v-divider />
          <v-card-text>
            <v-btn
              to="/users"
              color="primary"
              class="mb-2"
              block
              prepend-icon="mdi-account-plus"
            >
              Add User
            </v-btn>
            <v-btn
              @click="refreshStats"
              color="secondary"
              block
              prepend-icon="mdi-refresh"
            >
              Refresh Stats
            </v-btn>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { serverApi } from '@/api/admin'

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

const healthStatus = {
  get color(): string {
    return health.value.status === 'healthy' ? 'success' : 'error'
  }
}

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

async function refreshStats() {
  try {
    const [statsData, healthData] = await Promise.all([
      serverApi.stats(),
      serverApi.health(),
    ])
    stats.value = statsData
    health.value = healthData
  } catch (err) {
    console.error('Failed to load stats:', err)
  }
}

onMounted(() => {
  refreshStats()
})
</script>
