import type { Timestamped, WithId } from '@/shared/types';

export interface User extends WithId, Timestamped {
    username: string;
    email: string;
    is_admin: boolean;
    totp_enabled: boolean;
    require_2fa: boolean;
    public_key: string | null;
    disabled?: boolean;
}

export interface AuthResponse {
    access_token: string;
    refresh_token: string;
    user: User;
    expires_in?: number;
}

export interface AuthRequest {
    email: string;
    code: string;
    totp_code?: string;
}

export interface AuthCodeRequest {
    email: string;
}

export interface TOTPData {
    secret: string;
    qr_code: string;
}

export interface TwoFactorVerifyRequest {
    user_id: string;
    totp_code: string;
}

export interface TwoFactorSetupResponse {
    secret: string;
    qr_code_url: string;
    backup_codes: string[];
}

export interface BackupCodesResponse {
    remaining: number;
    codes?: string[];
}

export interface RefreshTokenRequest {
    refresh_token: string;
}

export interface RefreshTokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
}

// Store типы
export interface AuthState {
    user: User | null;
    accessToken: string | null;
    refreshToken: string | null;
    isAuthenticated: boolean;
    is2faSetup: boolean;
    isLoading: boolean;
    error: string | null;
}

export interface LoginFormData {
    email: string;
    code: string;
    totp_code?: string;
}

export type AuthStatus = 'idle' | 'requesting_code' | 'verifying_code' | 'verifying_2fa' | 'success' | 'error';