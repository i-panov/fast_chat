import { MantineProvider } from "@mantine/core";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileModal } from "./ProfileModal.tsx";

vi.mock("../../api.ts", () => ({
	uploadFile: vi.fn(),
	uploadUserAvatar: vi.fn(),
}));

vi.mock("../../hooks/useFileUrl.ts", () => ({
	useFileUrl: () => ({ blobUrl: null, loading: false, error: null }),
}));

const updateAccountUser = vi.fn();
vi.mock("../../useAuth.tsx", () => ({
	useAuth: () => ({ updateAccountUser }),
}));

const { uploadFile, uploadUserAvatar } = await import("../../api.ts");

beforeEach(() => {
	vi.clearAllMocks();
});

describe("ProfileModal", () => {
	it("uploads an avatar and updates the account", async () => {
		vi.mocked(uploadFile).mockResolvedValue({ file: { id: "f1" } } as never);
		vi.mocked(uploadUserAvatar).mockResolvedValue({
			user: {
				id: "a:test",
				nick: "alice",
				online: true,
				avatarUrl: "/api/files/f1",
			},
		});

		render(
			<MantineProvider>
				<ProfileModal
					open
					onClose={() => {}}
					token="tok"
					user={{ id: "a:test", nick: "alice" }}
				/>
			</MantineProvider>,
		);

		// biome-ignore lint/security/noSecrets: a DOM selector, not a secret.
		const input = document.querySelector('input[type="file"]');
		if (!(input instanceof HTMLInputElement)) throw new Error("no file input");
		const file = new File(["x"], "a.png", { type: "image/png" });
		fireEvent.change(input, { target: { files: [file] } });

		await waitFor(() => {
			expect(uploadFile).toHaveBeenCalledWith("tok", file);
			expect(uploadUserAvatar).toHaveBeenCalledWith("tok", "f1");
			expect(updateAccountUser).toHaveBeenCalledWith({
				id: "a:test",
				nick: "alice",
				avatarUrl: "/api/files/f1",
			});
		});
	});
});
