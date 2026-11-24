// readActiveToken returns the token of the session this tab should use. It
// checks the per-tab token first, then falls back to the last active token in
// localStorage: a fresh tab has an empty sessionStorage while the accounts are
// still there, and the AuthProvider restores the session from that value.
export function readActiveToken(): string | null {
	try {
		const session = sessionStorage.getItem("activeToken");
		if (session !== null) return session;
	} catch {
		// storage may be blocked
	}

	try {
		const raw = localStorage.getItem("accounts");
		if (raw === null) return null;
		const accounts = JSON.parse(raw) as Array<{ token: string }>;
		if (!Array.isArray(accounts) || accounts.length === 0) return null;
		const last = localStorage.getItem("activeToken");
		if (last !== null && accounts.some((a) => a.token === last)) return last;

		return accounts[0]?.token ?? null;
	} catch {
		return null;
	}
}
