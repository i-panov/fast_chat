import { createRouter, createWebHistory } from 'vue-router'
import { getAuth } from '@/db'
import LoginView from '@/views/LoginView.vue'
import ChatView from '@/views/ChatView.vue'
import ChannelView from '@/views/ChannelView.vue'

const AdminLayout = () => import('@/views/admin/DashboardLayout.vue')
const AdminDashboard = () => import('@/views/admin/Dashboard.vue')
const AdminUsers = () => import('@/views/admin/Users.vue')
const AdminSettings = () => import('@/views/admin/Settings.vue')

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: LoginView },
    { path: '/chat/:id?', name: 'chat', component: ChatView, meta: { auth: true } },
    { path: '/channel/:id?', name: 'channel', component: ChannelView, meta: { auth: true } },
    { path: '/', redirect: '/chat' },
    // Admin routes — lazy-loaded, only fetched if user navigates here
    {
      path: '/admin',
      component: AdminLayout,
      meta: { requiresAuth: true, requiresAdmin: true },
      children: [
        { path: '', name: 'admin', component: AdminDashboard },
        { path: 'users', name: 'admin-users', component: AdminUsers },
        { path: 'settings', name: 'admin-settings', component: AdminSettings },
      ],
    },
  ],
})

router.beforeEach(async (to) => {
  if (to.meta.auth || to.meta.requiresAuth) {
    const auth = await getAuth()
    if (!auth?.access_token) return { name: 'login' }
    if (to.meta.requiresAdmin && auth.user?.is_admin !== true) return { name: 'chat' }
  }
  if (to.name === 'login') {
    const auth = await getAuth()
    if (auth?.access_token) return { name: 'chat' }
  }
})

export default router
