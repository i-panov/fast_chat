<template>
  <v-container class="fill-height" fluid>
    <v-row justify="center" align="center">
      <v-col cols="12" sm="8" md="6" lg="4">
        <v-card class="pa-6">
          <v-card-title class="text-h4 text-center mb-4">
            <v-icon size="48" class="mr-2">{{ appIcon }}</v-icon>
            {{ appTitle }}
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
              <span v-if="devCode"> (dev code: <strong>{{ devCode }}</strong>)</span>
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

          <!-- Step 4: TOTP Setup -->
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

const props = defineProps<{
  appTitle: string
  appIcon: string
  apiPrefix?: string
  saveAuth?: (data: { user: any; access_token: string; refresh_token: string }) => void | Promise<void>
  onLoginSuccess: (data: { user: any; access_token: string; refresh_token: string }) => void
}>()

const apiPrefix = props.apiPrefix || '/api'

const step = ref(1)
const email = ref('')
const code = ref('')
const totpCode = ref('')
const devCode = ref('')
const error = ref('')
const loading = ref(false)
const qrDataUrl = ref('')
const pending2faUserId = ref('')

async function apiFetch(path: string, opts: RequestInit = {}) {
  const url = `${apiPrefix}${path}`
  const response = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
  })
  
  // Check content type before parsing
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    const text = await response.text()
    throw new Error(text || `HTTP ${response.status}: Server returned non-JSON response`)
  }
  
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(data?.error || data?.details || `HTTP ${response.status}`)
  }
  return data
}

async function requestCode() {
  if (!email.value) { error.value = 'Email is required'; return }
  loading.value = true
  error.value = ''
  try {
    const res = await apiFetch('/auth/request-code', {
      method: 'POST',
      body: JSON.stringify({ email: email.value }),
    })
    devCode.value = res.dev_code || ''
    step.value = 2
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Error'
  } finally {
    loading.value = false
  }
}

async function verifyCode() {
  if (code.value.length < 6) return
  loading.value = true
  error.value = ''
  try {
    const res = await apiFetch('/auth/verify-code', {
      method: 'POST',
      body: JSON.stringify({ email: email.value, code: code.value }),
    })
    if ('need_2fa' in res) {
      pending2faUserId.value = res.user_id
      if (res.require_2fa) {
        step.value = 4
        await setupTotp()
      } else {
        step.value = 3
      }
    } else {
      if (props.saveAuth) await props.saveAuth(res)
      await new Promise(r => setTimeout(r, 200))
      props.onLoginSuccess(res)
    }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Error'
  } finally {
    loading.value = false
  }
}

async function submit2fa() {
  if (!totpCode.value) return
  loading.value = true
  error.value = ''
  try {
    const res = await apiFetch('/auth/verify-2fa', {
      method: 'POST',
      body: JSON.stringify({ user_id: pending2faUserId.value, totp_code: totpCode.value }),
    })
    if ('need_2fa' in res && res.require_2fa) {
      step.value = 4
      await setupTotp()
    } else if ('access_token' in res) {
      if (props.saveAuth) await props.saveAuth(res)
      props.onLoginSuccess(res)
    }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Error'
  } finally {
    loading.value = false
  }
}

async function setupTotp() {
  try {
    const sd = await apiFetch('/auth/2fa/setup', {
      method: 'POST',
      body: JSON.stringify({ user_id: pending2faUserId.value }),
    })
    if (!sd.secret) throw new Error('No secret returned')
    qrDataUrl.value = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(sd.qr_code_url)}&size=200x200`
  } catch (e: unknown) {
    error.value = 'Failed to setup 2FA'
  }
}

async function submitTotpSetup() {
  if (!totpCode.value) return
  loading.value = true
  error.value = ''
  try {
    const res = await apiFetch('/auth/2fa/enable', {
      method: 'POST',
      body: JSON.stringify({ user_id: pending2faUserId.value, code: totpCode.value }),
    })
    if ('access_token' in res) {
      if (props.saveAuth) await props.saveAuth(res)
      props.onLoginSuccess(res)
    } else {
      error.value = 'Failed to login after 2FA setup'
    }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Error'
  } finally {
    loading.value = false
  }
}
</script>
