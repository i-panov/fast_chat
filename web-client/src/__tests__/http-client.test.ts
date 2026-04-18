import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpClient } from '@/core/api/http-client';

// Mock the db module (src/db/index.ts)
vi.mock('@/db', () => ({
    getAuth: vi.fn(),
    saveAuth: vi.fn(),
    clearAuth: vi.fn(),
    getCsrfToken: vi.fn(),
    saveCsrfToken: vi.fn(),
    getKeys: vi.fn(),
    saveKeys: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock crypto.subtle for CSRF token generation
Object.defineProperty(global, 'crypto', {
    value: {
        subtle: {
            digest: vi.fn(),
        },
        getRandomValues: vi.fn(),
    },
});

describe('HttpClient', () => {
    let httpClient: HttpClient;
    let mockDb: any;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockDb = await import('@/db');
        // Setup crypto mocks
        const mockRandomValues = new Uint8Array(32);
        // Fill with predictable values
        for (let i = 0; i < 32; i++) mockRandomValues[i] = i;
        // Override toString to return a string that btoa can encode
        mockRandomValues.toString = vi.fn(() => Array.from(mockRandomValues).join(','));
        (global.crypto.getRandomValues as any).mockReturnValue(mockRandomValues);
        // Setup subtle.digest mock
        (global.crypto.subtle.digest as any).mockResolvedValue(new Uint8Array([1, 2, 3]));

        httpClient = new HttpClient({
            baseUrl: 'http://localhost:8080/api',
        });
    });

    describe('constructor', () => {
        it('should create instance with default config', () => {
            const client = new HttpClient();
            expect(client).toBeInstanceOf(HttpClient);
        });

        it('should create instance with custom baseUrl', () => {
            const client = new HttpClient({ baseUrl: 'https://example.com/api' });
            expect(client).toBeInstanceOf(HttpClient);
        });
    });

    describe('request', () => {
        it('should make GET request and return data', async () => {
            const mockResponse = { data: 'test' };
            const headers = new Headers();
            headers.set('content-type', 'application/json');
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => mockResponse,
                text: async () => JSON.stringify(mockResponse),
                headers,
            });

            const result = await httpClient.request('/test');
            expect(mockFetch).toHaveBeenCalledWith(
                'http://localhost:8080/api/test',
                expect.objectContaining({
                    headers: expect.any(Object),
                })
            );
            expect(result).toEqual(mockResponse);
        });

        it('should include auth headers when authenticated', async () => {
            mockDb.getAuth.mockResolvedValue({
                access_token: 'access-token',
                refresh_token: 'refresh-token',
                user: null,
            });
            // Ensure tokens are loaded
            await httpClient.setTokens('access-token', 'refresh-token');
            const headers = new Headers();
            headers.set('content-type', 'application/json');
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({}),
                text: async () => '{}',
                headers,
            });

            await httpClient.request('/protected', { auth: true });
            expect(mockDb.getAuth).toHaveBeenCalled();
            expect(mockFetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer access-token',
                    }),
                })
            );
        });

        it('should retry with token refresh on 401', async () => {
            // First request returns 401
            const headers1 = new Headers();
            headers1.set('content-type', 'application/json');
            const headers2 = new Headers();
            headers2.set('content-type', 'application/json');
            const headers3 = new Headers();
            headers3.set('content-type', 'application/json');
            mockFetch
                .mockResolvedValueOnce({
                    ok: false,
                    status: 401,
                    json: async () => ({ error: 'Unauthorized' }),
                    text: async () => JSON.stringify({ error: 'Unauthorized' }),
                    headers: headers1,
                })
                // Refresh token request succeeds
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        access_token: 'new-access-token',
                        refresh_token: 'new-refresh-token',
                    }),
                    text: async () => JSON.stringify({
                        access_token: 'new-access-token',
                        refresh_token: 'new-refresh-token',
                    }),
                    headers: headers2,
                })
                // Second attempt succeeds
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({ success: true }),
                    text: async () => JSON.stringify({ success: true }),
                    headers: headers3,
                });

            mockDb.getAuth.mockResolvedValue({
                access_token: 'expired-token',
                refresh_token: 'refresh-token',
                user: null,
            });
            mockDb.saveAuth.mockResolvedValue(undefined);

            const result = await httpClient.request('/protected', { auth: true });
            expect(mockFetch).toHaveBeenCalledTimes(3);
            expect(result).toEqual({ success: true });
        });

        it('should throw sanitized error on network failure', async () => {
            // Ensure CSRF token is present to avoid calling crypto.getRandomValues
            mockDb.getCsrfToken.mockResolvedValue({
                token: 'csrf-token',
                expires: Date.now() + 3600000,
            });
            mockFetch.mockRejectedValueOnce(new Error('Network error'));

            await expect(httpClient.request('/test')).rejects.toThrow('Network error');
        });
    });

    describe('CSRF protection', () => {
        it('should include CSRF token in headers for non-GET requests', async () => {
            mockDb.getCsrfToken.mockResolvedValue({
                token: 'csrf-token',
                expires: Date.now() + 3600000,
            });
            const headers = new Headers();
            headers.set('content-type', 'application/json');
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({}),
                text: async () => '{}',
                headers,
            });

            await httpClient.post('/test', { data: 'value' });
            expect(mockFetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'X-CSRF-Token': 'csrf-token',
                    }),
                })
            );
        });

        it('should generate new CSRF token if expired', async () => {
            mockDb.getCsrfToken.mockResolvedValue({
                token: 'old-token',
                expires: Date.now() - 1000, // expired
            });
            mockDb.saveCsrfToken.mockResolvedValue(undefined);
            // Mock crypto.subtle.digest to return a fixed value
            vi.mocked(global.crypto.subtle.digest).mockResolvedValue(
                new Uint8Array([1, 2, 3])
            );
            const headers = new Headers();
            headers.set('content-type', 'application/json');
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({}),
                text: async () => '{}',
                headers,
            });

            // Spy on generateCsrfToken
            const generateSpy = vi.spyOn(httpClient, 'generateCsrfToken' as any);
            await httpClient.post('/test', {});
            // Should have saved new token
            expect(mockDb.getCsrfToken).toHaveBeenCalled();
            expect(generateSpy).toHaveBeenCalled();
            expect(mockDb.saveCsrfToken).toHaveBeenCalled();
        });
    });

    describe('token management', () => {
        it('should save tokens when setTokens is called', async () => {
            await httpClient.setTokens('new-access', 'new-refresh');
            expect(mockDb.saveAuth).toHaveBeenCalledWith({
                access_token: 'new-access',
                refresh_token: 'new-refresh',
                user: null,
            });
        });

        it('should clear tokens when clear is called', async () => {
            await httpClient.clear();
            expect(mockDb.clearAuth).toHaveBeenCalled();
        });
    });
});