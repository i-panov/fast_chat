<template>
  <v-container class="fill-height" fluid>
    <v-row justify="center" align="center">
      <v-col cols="12" sm="8" md="6" lg="4">
        <v-card class="pa-6">
          <v-card-title class="text-h4 text-center mb-4">
            <v-icon size="48" class="mr-2">mdi-message-text</v-icon>
            Fast Chat
          </v-card-title>

          <!-- Step 1: Enter email -->
          <template v-if="step === 1">
            <v-text-field
              v-model="email"
              label="Email"
              type="email"
              variant="outlined"
              prepend-inner-icon="mdi-email"
              @keyup.enter="requestCode"
              :error-messages="error"
            />
            <v-btn block color="primary" size="large" :loading="loading" @click="requestCode">
              Send Code
            </v-btn>
          </template>

          <!-- Step 2: Enter code -->
          <template v-else-if="step === 2">
            <v-alert type="info" variant="tonal" class="mb-4">
              Code sent to <strong>{{ email }}</strong>
              <span v-if="devCode"> (dev code: {{ devCode }})</span>
            </v-alert>
            <v-otp-input
              v-model="code"
              length="6"
              @finish="verifyCode"
            />
            <v-btn block color="primary" size="large" class="mt-4" :loading="loading" @click="verifyCode" :disabled="code.length < 6">
              Verify
            </v-btn>
          </template>

          <!-- Step 3: TOTP (if needed) -->
          <template v-else-if="step === 3">
            <v-alert type="warning" variant="tonal" class="mb-4">
              Two-factor authentication required
            </v-alert>
            <v-text-field
              v-model="totpCode"
              label="TOTP Code"
              variant="outlined"
              prepend-inner-icon="mdi-shield-key"
              @keyup.enter="submit2fa"
              :error-messages="error"
            />
            <v-btn block color="primary" size="large" :loading="loading" @click="submit2fa">
              Verify 2FA
            </v-btn>
          </template>

          <!-- Step 4: TOTP Setup (for new users / required) -->
          <template v-else-if="step === 4">
            <v-alert type="info" variant="tonal" class="mb-4">
              Scan the QR code with your authenticator app
            </v-alert>
            <v-img :src="qrDataUrl" max-width="200" class="mx-auto mb-4" />
            <v-text-field
              v-model="totpCode"
              label="Enter TOTP Code"
              variant="outlined"
              prepend-inner-icon="mdi-shield-key"
              @keyup.enter="submitTotpSetup"
              :error-messages="error"
            />
            <v-btn block color="primary" size="large" :loading="loading" @click="submitTotpSetup">
              Verify & Enable
            </v-btn>
          </template>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/api/client'
import { useAppStore } from '@/stores/app'

const router = useRouter()
const appStore = useAppStore()

const step = ref(1)
const email = ref('')
const code = ref('')
const totpCode = ref('')
const devCode = ref('')
const error = ref('')
const loading = ref(false)
const qrDataUrl = ref('')
const pending2faUserId = ref('')

async function requestCode() {
  if (!email.value) { error.value = 'Email is required'; return }
  loading.value = true
  error.value = ''
  try {
    const res = await api.requestCode(email.value)
    devCode.value = res.dev_code || ''
    step.value = 2
  } catch (e: any) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function verifyCode() {
  if (code.value.length < 6) return
  loading.value = true
  error.value = ''
  try {
    const res = await api.verifyCode(email.value, code.value) as any
    if ('need_2fa' in res) {
      if (res.require_2fa) {
        // Need to set up TOTP
        pending2faUserId.value = res.user_id
        step.value = 4
        await setupTotp()
      } else {
        // Just need to enter TOTP
        pending2faUserId.value = res.user_id
        step.value = 3
      }
    } else {
      // Logged in
      appStore.user = res.user
      appStore.isAuthenticated = true
      appStore.startSse()
      router.replace('/chat')
    }
  } catch (e: any) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function submit2fa() {
  if (!totpCode.value) return
  loading.value = true
  error.value = ''
  try {
    const res = await api.verify2fa(pending2faUserId.value, totpCode.value) as any
    if ('need_2fa' in res && res.require_2fa) {
      step.value = 4
      await setupTotp()
    } else if ('access_token' in res) {
      appStore.user = res.user
      appStore.isAuthenticated = true
      appStore.startSse()
      router.replace('/chat')
    }
  } catch (e: any) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function setupTotp() {
  try {
    const { secret, qr_code_url } = await api.setup2fa()
    // Generate QR code (simple — in production use a QR library)
    qrDataUrl.value = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr_code_url)}&size=200x200`
  } catch {
    error.value = 'Failed to setup 2FA'
  }
}

async function submitTotpSetup() {
  if (!totpCode.value) return
  loading.value = true
  error.value = ''
  try {
    await api.verify2faSetup(totpCode.value)
    const { backup_codes } = await api.enable2fa(totpCode.value)
    // In production, show backup codes
    appStore.is2faSetup = true
    // Now log in
    const res = await api.verifyCode(email.value, code.value) as any
    if ('access_token' in res) {
      appStore.user = res.user
      appStore.isAuthenticated = true
      appStore.startSse()
      router.replace('/chat')
    }
  } catch (e: any) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}
</script>
