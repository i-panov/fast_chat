import { createRouter, createWebHistory } from 'vue-router'
import { getAuth } from '@/db'
import LoginView from '@/views/LoginView.vue'
import ChatView from '@/views/ChatView.vue'
import ChannelView from '@/views/ChannelView.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: LoginView },
    { path: '/chat/:id?', name: 'chat', component: ChatView, meta: { auth: true } },
    { path: '/channel/:id?', name: 'channel', component: ChannelView, meta: { auth: true } },
    { path: '/', redirect: '/chat' },
  ],
})

router.beforeEach(async (to) => {
  if (to.meta.auth) {
    const auth = await getAuth()
    if (!auth?.access_token) return { name: 'login' }
  }
  if (to.name === 'login') {
    const auth = await getAuth()
    if (auth?.access_token) return { name: 'chat' }
  }
})

export default router
