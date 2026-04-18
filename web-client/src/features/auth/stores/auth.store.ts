import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useDbStore } from '@/core/db/stores/db.store';
import { authApi } from '../api/auth-api';
import { httpClient } from '@/core/api/http-client';
import type { AuthState, User, AuthResponse, AuthRequest, AuthCodeRequest, TwoFactorVerifyRequest, TwoFactorSetupResponse, BackupCodesResponse } from '../types';

export const useAuthStore = defineStore('auth', () => {
    const dbStore = useDbStore();

    // ─── State ───
    const state = ref<AuthState>({
        user: null,
        accessToken: null,
        refreshToken: null,
        isAuthenticated: false,
        is2faSetup: false,
        isLoading: false,
        error: null,
    });

    // ─── Getters ───
    const user = computed(() => state.value.user as User | null);
    const isAuthenticated = computed(() => state.value.isAuthenticated);
    const is2faSetup = computed(() => state.value.is2faSetup);
    const isLoading = computed(() => state.value.isLoading);
    const error = computed(() => state.value.error);
    const isAdmin = computed(() => state.value.user?.is_admin || false);
    const accessToken = computed(() => state.value.accessToken as string | null);
    const refreshToken = computed(() => state.value.refreshToken as string | null);

    // ─── Actions ───
    async function init() {
        try {
            state.value.isLoading = true;
            
            // Восстанавливаем аутентификацию из IndexedDB
            const auth = await dbStore.getAuth();
            
            if (auth) {
                state.value.user = auth.user;
                state.value.accessToken = auth.access_token;
                state.value.refreshToken = auth.refresh_token;
                state.value.isAuthenticated = true;
                state.value.is2faSetup = auth.user?.totp_enabled || false;
                
                // Устанавливаем токены в HttpClient
                if (auth.access_token && auth.refresh_token) {
                    await httpClient.setTokens(auth.access_token, auth.refresh_token);
                }
            }
        } catch (error) {
            console.error('Auth store init failed:', error);
            state.value.error = error instanceof Error ? error.message : 'Failed to initialize auth';
        } finally {
            state.value.isLoading = false;
        }
    }

    async function requestCode(email: string) {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            const request: AuthCodeRequest = { email };
            await authApi.requestCode(request);
            
            return { success: true };
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to request code';
            return { success: false, error: state.value.error };
        } finally {
            state.value.isLoading = false;
        }
    }

    async function verifyCode(email: string, code: string, totpCode?: string) {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            const request: AuthRequest = { email, code, totp_code: totpCode };
            const response = await authApi.verifyCode(request);
            
            await handleAuthResponse(response);
            
            return { 
                success: true, 
                need2fa: response.need_2fa,
                user_id: response.user_id 
            };
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to verify code';
            return { success: false, error: state.value.error };
        } finally {
            state.value.isLoading = false;
        }
    }

    async function verify2fa(userId: string, totpCode: string) {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            const request: TwoFactorVerifyRequest = { user_id: userId, totp_code: totpCode };
            const response = await authApi.verify2fa(request);
            
            await handleAuthResponse(response);
            
            return { success: true };
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to verify 2FA';
            return { success: false, error: state.value.error };
        } finally {
            state.value.isLoading = false;
        }
    }

    async function setup2fa() {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            const response: TwoFactorSetupResponse = await authApi.setup2fa();
            
            return { success: true, data: response };
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to setup 2FA';
            return { success: false, error: state.value.error };
        } finally {
            state.value.isLoading = false;
        }
    }

    async function enable2fa(totpCode: string) {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            await authApi.enable2fa(totpCode);
            
            if (state.value.user) {
                state.value.user.totp_enabled = true;
                state.value.is2faSetup = true;
                await dbStore.updateUser(state.value.user);
            }
            
            return { success: true };
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to enable 2FA';
            return { success: false, error: state.value.error };
        } finally {
            state.value.isLoading = false;
        }
    }

    async function disable2fa() {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            await authApi.disable2fa();
            
            if (state.value.user) {
                state.value.user.totp_enabled = false;
                state.value.is2faSetup = false;
                await dbStore.updateUser(state.value.user);
            }
            
            return { success: true };
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to disable 2FA';
            return { success: false, error: state.value.error };
        } finally {
            state.value.isLoading = false;
        }
    }

    async function getBackupCodes() {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            const response: BackupCodesResponse = await authApi.getBackupCodes();
            
            return { success: true, data: response };
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to get backup codes';
            return { success: false, error: state.value.error };
        } finally {
            state.value.isLoading = false;
        }
    }

    async function regenerateBackupCodes() {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            const response: BackupCodesResponse = await authApi.regenerateBackupCodes();
            
            return { success: true, data: response };
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to regenerate backup codes';
            return { success: false, error: state.value.error };
        } finally {
            state.value.isLoading = false;
        }
    }

    async function refreshTokens() {
        try {
            if (!state.value.refreshToken) {
                throw new Error('No refresh token available');
            }
            
            const response = await authApi.refreshTokens(state.value.refreshToken!);
            
            // Обновляем токены в состоянии
            state.value.accessToken = response.access_token;
            if (response.refresh_token) {
                state.value.refreshToken = response.refresh_token;
            }
            
            // Сохраняем в IndexedDB
            const auth = await dbStore.getAuth();
            if (auth) {
                await dbStore.saveAuth({
                    ...auth,
                    access_token: response.access_token,
                    refresh_token: response.refresh_token ?? auth.refresh_token,
                });
            }
            
            // Устанавливаем токены в HttpClient
            await httpClient.setTokens(response.access_token, response.refresh_token ?? state.value.refreshToken!);
            
            return { success: true };
        } catch (error) {
            console.error('Failed to refresh tokens:', error);
            await logout();
            throw error;
        }
    }

    async function logout() {
        try {
            state.value.isLoading = true;
            
            // Очищаем HttpClient
            await httpClient.clear();
            
            // Очищаем базу данных
            await dbStore.clearAuth();
            
            // Сбрасываем состояние
            state.value.user = null;
            state.value.accessToken = null;
            state.value.refreshToken = null;
            state.value.isAuthenticated = false;
            state.value.is2faSetup = false;
            state.value.error = null;
            
        } catch (error) {
            console.error('Logout failed:', error);
            state.value.error = error instanceof Error ? error.message : 'Logout failed';
        } finally {
            state.value.isLoading = false;
        }
    }

    async function updateProfile(updates: Partial<User>) {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            const updatedUser = await authApi.updateProfile(updates);
            
            state.value.user = updatedUser;
            await dbStore.updateUser(updatedUser);
            
            return { success: true, user: updatedUser };
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to update profile';
            return { success: false, error: state.value.error };
        } finally {
            state.value.isLoading = false;
        }
    }

    // ─── Public Helpers ───
    async function handleAuthResponse(response: AuthResponse) {
        state.value.user = response.user;
        state.value.accessToken = response.access_token;
        state.value.refreshToken = response.refresh_token;
        state.value.isAuthenticated = true;
        state.value.is2faSetup = response.user.totp_enabled;
        state.value.error = null;
        
        // Сохраняем в IndexedDB
        await dbStore.saveAuth({
            access_token: response.access_token,
            refresh_token: response.refresh_token,
            user: response.user,
            expires_at: response.expires_in ? Date.now() + response.expires_in * 1000 : undefined,
            created_at: Date.now(),
        });
        
        // Устанавливаем токены в HttpClient
        await httpClient.setTokens(response.access_token, response.refresh_token);
    }

    // ─── Return ───
    return {
        // State
        state,
        
        // Getters
        user,
        isAuthenticated,
        is2faSetup,
        isLoading,
        error,
        isAdmin,
        accessToken,
        refreshToken,
        
        // Actions
        init,
        requestCode,
        verifyCode,
        verify2fa,
        setup2fa,
        enable2fa,
        disable2fa,
        getBackupCodes,
        regenerateBackupCodes,
        refreshTokens,
        logout,
        updateProfile,
        handleAuthResponse,
    };
});