import api from './index'
import type { User, CreateUserRequest, UpdateUserRequest } from './types'

export const userApi = {
  async list(page = 1, pageSize = 50): Promise<User[]> {
    const { data } = await api.get<User[]>('/users', {
      params: { page, page_size: pageSize },
    })
    return data
  },

  async create(user: CreateUserRequest): Promise<User> {
    const { data } = await api.post<User>('/users', user)
    return data
  },

  async update(id: string, user: UpdateUserRequest): Promise<User> {
    const { data } = await api.put<User>(`/users/${id}`, user)
    return data
  },

  async delete(id: string): Promise<void> {
    await api.delete(`/users/${id}`)
  },

  async setAdmin(id: string, isAdmin: boolean): Promise<void> {
    await api.put(`/users/${id}/admin`, { is_admin: isAdmin })
  },

  async setDisabled(id: string, disabled: boolean): Promise<void> {
    await api.put(`/users/${id}/disable`, { is_admin: disabled })
  },
}
