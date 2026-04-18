import { httpClient } from './http-client';
import type { FileMeta } from '@/types';

export class FileApi {
    private client = httpClient;

    /**
     * Загрузить файл в чат
     */
    async uploadFile(chatId: string, file: File): Promise<FileMeta> {
        const formData = new FormData();
        formData.append('file', file);
        // Используем прямой fetch, так как HttpClient не поддерживает FormData
        const response = await fetch(`${import.meta.env.VITE_API_BASE || ''}/api/files/upload-chat/${chatId}`, {
            method: 'POST',
            headers: await this.client.getAuthHeaders(true),
            body: formData,
        });
        if (!response.ok) {
            throw new Error(`Upload failed: ${response.status}`);
        }
        return response.json();
    }

    /**
     * Загрузить файл (общий)
     */
    async upload(file: File): Promise<FileMeta> {
        const formData = new FormData();
        formData.append('file', file);
        const response = await fetch(`${import.meta.env.VITE_API_BASE || ''}/api/files/upload`, {
            method: 'POST',
            headers: await this.client.getAuthHeaders(true),
            body: formData,
        });
        if (!response.ok) {
            throw new Error(`Upload failed: ${response.status}`);
        }
        return response.json();
    }

    /**
     * Скачать файл по ID
     */
    async downloadFile(fileId: string): Promise<Blob> {
        const response = await fetch(`${import.meta.env.VITE_API_BASE || ''}/api/files/${fileId}`, {
            headers: await this.client.getAuthHeaders(true),
        });
        if (!response.ok) {
            throw new Error(`Download failed: ${response.status}`);
        }
        return response.blob();
    }

    /**
     * Получить метаданные файла
     */
    async getFileMeta(fileId: string): Promise<FileMeta> {
        return this.client.get(`/api/files/${fileId}/meta`);
    }
}

export const fileApi = new FileApi();