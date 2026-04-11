<template>
  <v-container class="fill-height" fluid>
    <v-row justify="center" align="center">
      <v-col cols="12" sm="8" md="4">
        <v-card class="elevation-12">
          <v-toolbar color="primary" density="compact">
            <v-toolbar-title class="text-h6">
              <v-icon start>mdi-shield-check</v-icon>
              FastChat Admin
            </v-toolbar-title>
          </v-toolbar>

          <v-card-text>
            <p v-if="step === 1">Enter your admin email to receive a login code.</p>
            <p v-if="step === 2">Code sent! Enter the 6-digit code (dev code shown above).</p>
            <p v-if="step === 3">Enter your 2FA code.</p>
            <p v-if="step === 4">Scan QR and enter TOTP code.</p>

            <!-- Step 1: Email -->
            <v-text-field
              v-if="step === 1"
              v-model="email"
              label="Email"
              type="email"
              variant="outlined"
              class="mt-2"
            />

            <!-- Step 2: Code -->
            <v-text-field
              v-if="step === 2"
              v-model="code"
              label="Verification Code"
              type="text"
              variant="outlined"
              maxlength="6"
              class="mt-2"
            />

            <!-- Step 3/4: TOTP -->
            <v-text-field
              v-if="step === 3 || step === 4"
              v-model="totpCode"
              label="TOTP Code"
              type="text"
              variant="outlined"
              maxlength="6"
              class="mt-2"
            />

            <v-img v-if="step === 4 && qrUrl" :src="qrUrl" max-width="200" class="mx-auto mt-4 mb-4" />

            <v-btn color="primary" block size="large" :loading="loading" @click="doAction">
              {{ actionLabel }}
            </v-btn>
          </v-card-text>

          <v-alert v-if="error" type="error" variant="tonal" density="compact" class="ma-4">
            {{ error }}
          </v-alert>

          <v-alert v-if="devCode" type="info" variant="tonal" density="compact" class="mx-4 mb-4">
            Dev code: <strong>{{ devCode }}</strong>
          </v-alert>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const step = ref(1)
const email = ref('')
const code = ref('')
const totpCode = ref('')
const devCode = ref('')
const loading = ref(false)
const error = ref('')
const qrUrl = ref('')
const pendingUserId = ref('')

const actionLabel = computed(() => {
  if (step.value === 1) return 'Send Code'
  if (step.value === 2) return 'Verify & Login'
  if (step.value === 3) return 'Verify 2FA'
  return 'Verify & Enable'
})

async function doAction() {
  loading.value = true
  error.value = ''

  try {
    if (step.value === 1) {
      const res = await fetch('/api/auth/request-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.value }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      devCode.value = data.dev_code || ''
      step.value = 2

    } else if (step.value === 2) {
      const res = await fetch('/api/auth/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.value, code: code.value }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      if (data.need_2fa) {
        pendingUserId.value = data.user_id
        step.value = data.require_2fa ? 4 : 3
        if (data.require_2fa) {
          const sr = await fetch('/api/auth/2fa/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
          const sd = await sr.json()
          qrUrl.value = 'https://api.qrserver.com/v1/create-qr-code/?data=' + encodeURIComponent(sd.qr_code_url) + '&size=200x200'
        }
      } else {
        if (!data.user?.is_admin) { error.value = 'Admin access required'; return }
        localStorage.setItem('admin_token', data.access_token)
        router.push('/')
      }

    } else if (step.value === 3) {
      const res = await fetch('/api/auth/verify-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: pendingUserId.value, totp_code: totpCode.value }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      if (!data.user?.is_admin) { error.value = 'Admin access required'; return }
      localStorage.setItem('admin_token', data.access_token)
      router.push('/')

    } else if (step.value === 4) {
      await fetch('/api/auth/2fa/verify-setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: totpCode.value }) })
      await fetch('/api/auth/2fa/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: totpCode.value }) })
      const res = await fetch('/api/auth/verify-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.value, code: code.value }) })
      const data = await res.json()
      if (!data.user?.is_admin) { error.value = 'Admin access required'; return }
      localStorage.setItem('admin_token', data.access_token)
      router.push('/')
    }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Error'
  } finally {
    loading.value = false
  }
}
</script>
