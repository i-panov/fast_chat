<template>
  <div>
    <div class="d-flex justify-space-between align-center mb-6">
      <h1 class="text-h4">Users</h1>
      <v-btn color="primary" prepend-icon="mdi-account-plus" @click="openCreateDialog">
        Add User
      </v-btn>
    </div>

    <v-data-table
      :headers="headers"
      :items="users"
      :loading="loading"
      class="elevation-1"
    >
      <template #item.is_admin="{ item }">
        <v-chip :color="item.is_admin ? 'primary' : 'grey'" size="small">
          {{ item.is_admin ? 'Admin' : 'User' }}
        </v-chip>
      </template>

      <template #item.disabled="{ item }">
        <v-chip :color="item.disabled ? 'error' : 'success'" size="small">
          {{ item.disabled ? 'Disabled' : 'Active' }}
        </v-chip>
      </template>

      <template #item.totp_enabled="{ item }">
        <v-icon :color="item.totp_enabled ? 'success' : 'grey'">
          {{ item.totp_enabled ? 'mdi-shield-check' : 'mdi-shield-off' }}
        </v-icon>
      </template>

      <template #item.actions="{ item }">
        <v-icon class="mr-2" size="small" @click="openEditDialog(item)">
          mdi-pencil
        </v-icon>
        <v-icon
          size="small"
          :color="item.disabled ? 'success' : 'warning'"
          @click="toggleDisabled(item)"
        >
          {{ item.disabled ? 'mdi-check-circle' : 'mdi-cancel' }}
        </v-icon>
        <v-icon size="small" color="error" class="ml-2" @click="confirmDelete(item)">
          mdi-delete
        </v-icon>
      </template>
    </v-data-table>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialogOpen" max-width="500">
      <v-card>
        <v-card-title>{{ isEditing ? 'Edit User' : 'Create User' }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef" v-model="formValid">
            <v-text-field
              v-model="form.username"
              label="Username"
              variant="outlined"
              :rules="[v => !!v || 'Required']"
              required
            />
            <v-text-field
              v-if="!isEditing"
              v-model="form.password"
              label="Password"
              type="password"
              variant="outlined"
              :rules="!isEditing ? [v => !!v || 'Required'] : []"
              required
            />
            <v-switch
              v-model="form.is_admin"
              label="Is Admin"
              color="primary"
            />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="dialogOpen = false">Cancel</v-btn>
          <v-btn
            color="primary"
            :loading="dialogLoading"
            :disabled="!formValid"
            @click="saveUser"
          >
            {{ isEditing ? 'Update' : 'Create' }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete Confirmation -->
    <v-dialog v-model="deleteDialogOpen" max-width="400">
      <v-card>
        <v-card-title>Delete User?</v-card-title>
        <v-card-text>
          Are you sure you want to delete <strong>{{ selectedUser?.username }}</strong>?
          This action cannot be undone.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="deleteDialogOpen = false">Cancel</v-btn>
          <v-btn color="error" :loading="dialogLoading" @click="deleteUser">
            Delete
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Snackbar -->
    <v-snackbar v-model="snackbar" :color="snackbarColor" timeout="3000">
      {{ snackbarText }}
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { userApi } from '@/api/admin'
import type { User, CreateUserRequest, UpdateUserRequest } from '@/api/admin/types'

const headers = [
  { title: 'Username', key: 'username' },
  { title: 'Role', key: 'is_admin' },
  { title: 'Status', key: 'disabled' },
  { title: '2FA', key: 'totp_enabled', sortable: false },
  { title: 'Actions', key: 'actions', sortable: false },
]

const users = ref<User[]>([])
const loading = ref(false)

// Dialog state
const dialogOpen = ref(false)
const isEditing = ref(false)
const formValid = ref(false)
const dialogLoading = ref(false)
const selectedUser = ref<User | null>(null)
const formRef = ref<InstanceType<typeof import('vuetify/components/VForm')['VForm']> | null>(null)

const form = ref({
  username: '',
  password: '',
  is_admin: false,
})

// Snackbar
const snackbar = ref(false)
const snackbarText = ref('')
const snackbarColor = ref('success')

function showSnackbar(message: string, color = 'success') {
  snackbarText.value = message
  snackbarColor.value = color
  snackbar.value = true
}

async function loadUsers() {
  loading.value = true
  try {
    users.value = await userApi.list()
  } catch (err) {
    console.error('Failed to load users:', err)
    showSnackbar('Failed to load users', 'error')
  } finally {
    loading.value = false
  }
}

function openCreateDialog() {
  isEditing.value = false
  form.value = { username: '', password: '', is_admin: false }
  dialogOpen.value = true
}

function openEditDialog(user: User) {
  isEditing.value = true
  selectedUser.value = user
  form.value = {
    username: user.username,
    password: '',
    is_admin: user.is_admin,
  }
  dialogOpen.value = true
}

async function saveUser() {
  if (!formValid.value) return
  dialogLoading.value = true

  try {
    if (isEditing.value && selectedUser.value) {
      const update: UpdateUserRequest = {
        username: form.value.username,
      }
      await userApi.update(selectedUser.value.id, update)
      if (form.value.is_admin !== selectedUser.value.is_admin) {
        await userApi.setAdmin(selectedUser.value.id, form.value.is_admin)
      }
      showSnackbar('User updated successfully')
    } else {
      const create: CreateUserRequest = {
        username: form.value.username,
        password: form.value.password,
        is_admin: form.value.is_admin,
      }
      await userApi.create(create)
      showSnackbar('User created successfully')
    }
    dialogOpen.value = false
    await loadUsers()
  } catch (err) {
    console.error('Failed to save user:', err)
    showSnackbar('Failed to save user', 'error')
  } finally {
    dialogLoading.value = false
  }
}

function confirmDelete(user: User) {
  selectedUser.value = user
  deleteDialogOpen.value = true
}

const deleteDialogOpen = ref(false)

async function deleteUser() {
  if (!selectedUser.value) return
  dialogLoading.value = true

  try {
    await userApi.delete(selectedUser.value.id)
    showSnackbar('User deleted successfully')
    deleteDialogOpen.value = false
    await loadUsers()
  } catch (err) {
    console.error('Failed to delete user:', err)
    showSnackbar('Failed to delete user', 'error')
  } finally {
    dialogLoading.value = false
  }
}

async function toggleDisabled(user: User) {
  try {
    await userApi.setDisabled(user.id, !user.disabled)
    showSnackbar(`User ${user.disabled ? 'enabled' : 'disabled'}`)
    await loadUsers()
  } catch (err) {
    console.error('Failed to toggle user status:', err)
    showSnackbar('Failed to update user', 'error')
  }
}

onMounted(() => {
  loadUsers()
})
</script>
