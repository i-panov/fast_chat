import * as db from '@/db';

const API_BASE = import.meta.env.VITE_API_BASE || '';

export type RequestOptions = RequestInit & {
  /**
   * Whether to include authentication headers (default: true).
   * If false, the request will be sent without Authorization and X-CSRF-Token.
   */
  auth?: boolean;
  /**
   * Custom headers to merge with default headers.
   */
  headers?: Record<string, string>;
  /**
   * Whether to retry on 401 with token refresh (default: true).
   */
  retryOnUnauthorized?: boolean;
};

export type HttpClientConfig = {
  /**
   * Base URL for all requests.
   */
  baseUrl?: string;
  /**
   * Function to get authentication tokens.
   */
  getTokens?: () => Promise<{ access: string | null; refresh: string | null }>;
  /**
   * Function to save new tokens after refresh.
   */
  saveTokens?: (tokens: { access: string; refresh: string }) => Promise<void>;
  /**
   * Function to clear tokens on logout.
   */
  clearTokens?: () => Promise<void>;
  /**
   * Function to get CSRF token.
   */
  getCsrfToken?: () => Promise<string | null>;
  /**
   * Function to generate new CSRF token.
   */
  generateCsrfToken?: () => Promise<string>;
};

/**
 * HTTP client with built-in token management, CSRF protection, and automatic retry.
 * Designed to be used as a base for feature-specific API clients.
 */
export class HttpClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private csrfToken: string | null = null;
  private refreshPromise: Promise<string> | null = null;
  private readonly baseUrl: string;
  private readonly getTokens: () => Promise<{ access: string | null; refresh: string | null }>;
  private readonly saveTokens: (tokens: { access: string; refresh: string }) => Promise<void>;
  private readonly clearTokens: () => Promise<void>;
  private readonly getCsrfToken: () => Promise<string | null>;
  private readonly generateCsrfToken: () => Promise<string>;

  constructor(config: HttpClientConfig = {}) {
    this.baseUrl = config.baseUrl ?? API_BASE;
    this.getTokens = config.getTokens ?? this.defaultGetTokens;
    this.saveTokens = config.saveTokens ?? this.defaultSaveTokens;
    this.clearTokens = config.clearTokens ?? this.defaultClearTokens;
    this.getCsrfToken = config.getCsrfToken ?? this.defaultGetCsrfToken;
    this.generateCsrfToken = config.generateCsrfToken ?? this.defaultGenerateCsrfToken;

    // Initialize tokens from storage
    this.init();
  }

  private async init() {
    await this.loadTokens();
    await this.loadCsrfToken();
  }

  private async loadTokens() {
    const tokens = await this.getTokens();
    this.accessToken = tokens.access;
    this.refreshToken = tokens.refresh;
  }

  private async loadCsrfToken() {
    this.csrfToken = await this.getCsrfToken();
  }

  // Default implementations using the existing db module
  private defaultGetTokens = async (): Promise<{ access: string | null; refresh: string | null }> => {
    const auth = await db.getAuth();
    return {
      access: auth?.access_token ?? null,
      refresh: auth?.refresh_token ?? null,
    };
  };

  private defaultSaveTokens = async (tokens: { access: string; refresh: string }): Promise<void> => {
    // We need the user object; retrieve current auth to preserve user data.
    const auth = await db.getAuth();
    // auth should exist when saving tokens (after authentication or refresh)
    if (!auth) {
        throw new Error('Cannot save tokens without existing auth');
    }
    await db.saveAuth({
      access_token: tokens.access,
      refresh_token: tokens.refresh,
      user: auth.user,
    });
  };

  private defaultClearTokens = async (): Promise<void> => {
    await db.clearAuth();
  };

  private defaultGetCsrfToken = async (): Promise<string | null> => {
    const stored = await db.getCsrfToken();
    if (stored && this.isTokenValid(stored)) {
      return stored.token;
    }
    return null;
  };

  private defaultGenerateCsrfToken = async (): Promise<string> => {
    const token = btoa(crypto.getRandomValues(new Uint8Array(32)).toString());
    const expires = Date.now() + 3600000; // 1 hour
    await db.saveCsrfToken({ token, expires });
    return token;
  };

  private isTokenValid(tokenData: { token: string; expires: number }): boolean {
    return Date.now() < tokenData.expires;
  }

  /**
   * Get current authentication headers.
   */
  public async getAuthHeaders(auth: boolean = true): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (auth) {
      if (this.accessToken) {
        headers.Authorization = `Bearer ${this.accessToken}`;
      }
      if (this.csrfToken) {
        headers['X-CSRF-Token'] = this.csrfToken;
      } else {
        // Generate CSRF token if missing
        this.csrfToken = await this.generateCsrfToken();
        headers['X-CSRF-Token'] = this.csrfToken;
      }
    }
    return headers;
  }

  /**
   * Merge default headers with request-specific headers.
   */
  private async mergeHeaders(options: RequestOptions): Promise<Record<string, string>> {
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const authHeaders = await this.getAuthHeaders(options.auth ?? true);
    const customHeaders = options.headers ?? {};

    return { ...baseHeaders, ...authHeaders, ...customHeaders };
  }

  /**
   * Perform a token refresh.
   */
  private async refresh(): Promise<string> {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }

    const response = await fetch(`${this.baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: this.refreshToken }),
    });

    if (!response.ok) {
      throw new Error('Refresh failed');
    }

    const data = await response.json();
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;
    await this.saveTokens({
      access: data.access_token,
      refresh: data.refresh_token,
    });

    return data.access_token;
  }

  /**
   * Sanitize error message to prevent information disclosure.
   */
  private sanitizeError(error: string): string {
    const sensitivePatterns = [
      /token/i,
      /password/i,
      /secret/i,
      /key/i,
      /auth/i,
      /jwt/i,
      /bearer/i,
      /stack trace/i,
      /at\s+\w+\.\w+\(/i,
      /file:\/\//i,
      /c:\\\\/i,
      /\/home\//i,
    ];

    let sanitized = error;
    for (const pattern of sensitivePatterns) {
      sanitized = sanitized.replace(pattern, '[REDACTED]');
    }

    if (sanitized.length > 200) {
      sanitized = sanitized.substring(0, 200) + '...';
    }

    return sanitized || 'An error occurred';
  }

  /**
   * Core request method.
   */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = await this.mergeHeaders(options);
    const { auth = true, retryOnUnauthorized = true, ...fetchOptions } = options;

    let response = await fetch(url, {
      ...fetchOptions,
      headers,
    });

    // Handle 401 with token refresh
    if (response.status === 401 && retryOnUnauthorized && auth && this.refreshToken) {
      if (!this.refreshPromise) {
        this.refreshPromise = this.refresh();
      }

      try {
        const newToken = await this.refreshPromise;
        this.refreshPromise = null;
        // Retry with new token
        headers.Authorization = `Bearer ${newToken}`;
        response = await fetch(url, {
          ...fetchOptions,
          headers,
        });
      } catch {
        this.refreshPromise = null;
        await this.clearTokens();
        this.accessToken = null;
        this.refreshToken = null;
        throw new Error('AUTH_REQUIRED');
      }
    }

    // If still 401, clear tokens and throw
    if (response.status === 401) {
      await this.clearTokens();
      this.accessToken = null;
      this.refreshToken = null;
      throw new Error('AUTH_REQUIRED');
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const errorMessage = this.sanitizeError(
        body.error || body.details || `HTTP ${response.status}`,
      );
      throw new Error(errorMessage);
    }

    // Handle empty responses (e.g., 204 No Content)
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return response.json();
    }

    // For non-JSON responses, return as text (or blob if needed)
    return response.text() as unknown as T;
  }

  /**
   * Shorthand for GET request.
   */
  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  /**
   * Shorthand for POST request.
   */
  post<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(path, {
      ...options,
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  /**
   * Shorthand for PUT request.
   */
  put<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(path, {
      ...options,
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  /**
   * Shorthand for DELETE request.
   */
  delete<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'DELETE' });
  }

  /**
   * Update stored tokens (e.g., after login).
   */
  async setTokens(accessToken: string, refreshToken: string): Promise<void> {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    await this.saveTokens({ access: accessToken, refresh: refreshToken });
  }

  /**
   * Clear tokens (logout).
   */
  async clear(): Promise<void> {
    await this.clearTokens();
    this.accessToken = null;
    this.refreshToken = null;
    this.csrfToken = null;
  }

  /**
   * Get current access token (for external use, e.g., SSE).
   */
  getAccessToken(): string | null {
    return this.accessToken;
  }

}

/**
 * Default singleton instance for convenience.
 */
export const httpClient = new HttpClient();