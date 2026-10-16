import { MantineProvider } from "@mantine/core";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";
import type { FileInfo } from "../../types/api.ts";
import { AuthProvider } from "../../useAuth.tsx";

export function seedAccount() {
	localStorage.setItem(
		"accounts",
		JSON.stringify([
			{
				token: "tok",
				user: { id: "alice:test", nick: "alice" },
				email: "a@example.com",
				expiresAt: "2027-01-01T00:00:00Z",
			},
		]),
	);
	sessionStorage.setItem("activeToken", "tok");
}

export function renderWithAccount(ui: ReactElement) {
	return render(
		<MantineProvider>
			<AuthProvider>{ui}</AuthProvider>
		</MantineProvider>,
	);
}

export function stubBlobUrls() {
	URL.createObjectURL = vi.fn(() => "blob:mock");
	URL.revokeObjectURL = vi.fn();
}

export function photoFile(overrides: Partial<FileInfo> = {}): FileInfo {
	return {
		id: "f1",
		mimeType: "image/png",
		size: 10,
		originalName: "pic.png",
		fileType: "photo",
		url: "https://srv/f/1",
		...overrides,
	};
}
