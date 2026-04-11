import api from './index'
import type { HealthResponse, StatsResponse } from './types'

export const serverApi = {
  async health(): Promise<HealthResponse> {
    const { data } = await api.get<HealthResponse>('/health')
    return data
  },

  async stats(): Promise<StatsResponse> {
    const { data } = await api.get<StatsResponse>('/stats')
    return data
  },
}
