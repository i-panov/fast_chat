// Базовые типы, используемые во всём приложении
export interface Timestamped {
    created_at: string;
    updated_at?: string;
}

export interface WithId {
    id: string;
}

export type Status = 'idle' | 'loading' | 'success' | 'error';

export interface ApiError {
    message: string;
    code?: string;
    status?: number;
    details?: Record<string, unknown>;
}

export interface PaginatedResponse<T> {
    items: T[];
    total: number;
    page: number;
    per_page: number;
    has_more: boolean;
}

export interface PaginationParams {
    page?: number;
    per_page?: number;
    sort_by?: string;
    sort_order?: 'asc' | 'desc';
}