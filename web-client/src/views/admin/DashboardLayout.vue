<template>
  <v-navigation-drawer v-model="drawer" :rail="rail" permanent>
    <v-list-item
      title="FastChat Admin"
      prepend-avatar="mdi-shield-check"
      class="font-weight-bold"
    />
    <v-divider />
    <div class="nav-links">
      <router-link
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        class="nav-link"
        :class="{ 'nav-link-active': route.path === item.path }"
      >
        <v-icon>{{ item.icon }}</v-icon>
        <span class="nav-link-text">{{ item.title }}</span>
      </router-link>
    </div>
    <template #append>
      <v-divider />
      <div class="nav-links pb-4">
        <a class="nav-link" @click="handleLogout" style="cursor: pointer;">
          <v-icon>mdi-logout</v-icon>
          <span class="nav-link-text">Logout</span>
        </a>
      </div>
    </template>
  </v-navigation-drawer>

  <v-app-bar elevation="1">
    <v-app-bar-nav-icon @click="rail = !rail" />
    <v-toolbar-title>{{ currentTitle }}</v-toolbar-title>
    <v-spacer />
    <v-chip variant="tonal" color="success" class="mr-4">
      <v-icon start>mdi-check-circle</v-icon>
      Online
    </v-chip>
  </v-app-bar>

  <v-main>
    <v-container fluid class="pa-6">
      <router-view />
    </v-container>
  </v-main>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAppStore } from '@/stores/app'

const router = useRouter()
const route = useRoute()
const appStore = useAppStore()

const drawer = ref(true)
const rail = ref(false)

const navItems = [
  { title: 'Dashboard', path: '/', icon: 'mdi-view-dashboard' },
  { title: 'Users', path: '/users', icon: 'mdi-account-multiple' },
  { title: 'Settings', path: '/settings', icon: 'mdi-cog' },
]

const currentTitle = computed(() => {
  const item = navItems.find(i => i.path === route.path)
  return item?.title || 'Dashboard'
})

function handleLogout() {
  appStore.logout()
  router.push('/login')
}
</script>

<style scoped>
.nav-links {
  display: flex;
  flex-direction: column;
  padding: 8px;
}

.nav-link {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 8px;
  text-decoration: none;
  color: #bdbdbd;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.nav-link:hover {
  background-color: rgba(255, 255, 255, 0.08);
  color: #ffffff;
}

.nav-link-text {
  font-size: 14px;
  font-weight: 400;
}

.nav-link-active {
  background-color: #1976D2;
  color: #ffffff !important;
}

.nav-link-active:hover {
  background-color: #1976D2;
}

.nav-link-active .nav-link-text {
  color: #ffffff !important;
  font-weight: 600;
}

.nav-link-active .v-icon {
  color: #ffffff !important;
}
</style>
