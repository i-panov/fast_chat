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
            <v-form v-model="formValid" @submit.prevent="handleLogin">
              <v-text-field
                v-model="username"
                prepend-inner-icon="mdi-account"
                label="Username"
                type="text"
                variant="outlined"
                :rules="[v => !!v || 'Username is required']"
                required
              />
              <v-text-field
                v-model="password"
                prepend-inner-icon="mdi-lock"
                label="Password"
                type="password"
                variant="outlined"
                :rules="[v => !!v || 'Password is required']"
                required
              />
              <v-text-field
                v-if="show2FA"
                v-model="totpCode"
                prepend-inner-icon="mdi-shield-key"
                label="2FA Code"
                type="text"
                variant="outlined"
                placeholder="123456"
                maxlength="6"
                :rules="[v => v.length === 6 || 'Must be 6 digits']"
              />
              <v-btn
                type="submit"
                color="primary"
                block
                size="large"
                :loading="loading"
                :disabled="!formValid"
              >
                Login
              </v-btn>
            </v-form>
          </v-card-text>

          <v-alert
            v-if="error"
            type="error"
            variant="tonal"
            density="compact"
            class="ma-4"
          >
            {{ error }}
          </v-alert>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()

const username = ref('')
const password = ref('')
const totpCode = ref('')
const show2FA = ref(false)
const formValid = ref(false)
const loading = ref(false)
const error = ref('')

async function handleLogin() {
  loading.value = true
  error.value = ''

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: username.value,
        password: password.value,
        totp_code: totpCode.value || null,
      }),
    })

    if (response.status === 403) {
      show2FA.value = true
      error.value = 'Enter your 2FA code'
      return
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Invalid username or password')
      }
      throw new Error(`Login failed: ${response.status}`)
    }

    const data = await response.json()

    if (!data.user?.is_admin) {
      error.value = 'Access denied: admin privileges required'
      return
    }

    localStorage.setItem('admin_token', data.access_token)
    router.push('/')
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Login failed'
  } finally {
    loading.value = false
  }
}
</script>
