const HTTP_UNAUTHORIZED = 401;

async function request<T>(
	path: string,
	token: string | undefined,
	init?: RequestInit,
): Promise<T> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (token !== undefined) {
		headers.Authorization = `Bearer ${token}`;
	}
	const res = await fetch(path, { ...init, headers });
	if (res.status === HTTP_UNAUTHORIZED) {
		const raw = localStorage.getItem("accounts");
		if (raw !== null) {
			const accounts = JSON.parse(raw) as {
				token: string;
				user: { id: string; nick: string };
			}[];
			const filtered = accounts.filter((a) => a.token !== token);
			localStorage.setItem("accounts", JSON.stringify(filtered));
			if (filtered.length === 0) {
				window.location.href = "/login";
			}
		} else {
			window.location.href = "/login";
		}
		throw new Error("unauthorized");
	}
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as Record<string, string>;
		throw new Error(body.error ?? `HTTP ${String(res.status)}`);
	}
	return res.json() as Promise<T>;
}

export interface User {
	id: string;
	nick: string;
	online: boolean;
}

export interface MemberInfo {
	id: string;
	nick: string;
}

export interface Chat {
	id: string;
	members: MemberInfo[];
	createdAt: string;
}

export interface Message {
	id: string;
	chatId: string;
	fromId: string;
	fromNick: string;
	text: string;
	createdAt: string;
}

export function register(nick: string) {
	return request<{ user: User; token: string }>("/api/register", undefined, {
		method: "POST",
		body: JSON.stringify({ nick }),
	});
}

export function searchUsers(token: string, q: string) {
	return request<{ users: User[] }>(
		`/api/users/search?q=${encodeURIComponent(q)}`,
		token,
	);
}

export function getChats(token: string) {
	return request<{ chats: Chat[] }>("/api/chats", token);
}

export function createChat(token: string, withUserId: string) {
	return request<{ chat: Chat }>("/api/chats", token, {
		method: "POST",
		body: JSON.stringify({ withUserId }),
	});
}

export function getMessages(token: string, chatId: string) {
	return request<{ messages: Message[] }>(
		`/api/chats/${chatId}/messages`,
		token,
	);
}

export function sendMessage(token: string, chatId: string, text: string) {
	return request<{ message: Message }>(`/api/chats/${chatId}/messages`, token, {
		method: "POST",
		body: JSON.stringify({ text }),
	});
}
