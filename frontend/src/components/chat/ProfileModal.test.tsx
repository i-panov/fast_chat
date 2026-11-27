import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileModal } from "./ProfileModal.tsx";

vi.mock("../../api.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../api.ts")>();

	return {
		...actual,
		uploadFile: vi.fn(),
		uploadUserAvatar: vi.fn(),
	};
});

vi.mock("../../hooks/useFileUrl.ts", () => ({
	useFileUrl: () => ({ blobUrl: null, loading: false, error: null }),
}));

const updateAccountUser = vi.fn();
vi.mock("../../useAuth.tsx", () => ({
	useAuth: () => ({ updateAccountUser }),
}));

const { uploadFile, uploadUserAvatar } = await import("../../api.ts");

function fileInput(): HTMLInputElement {
	// biome-ignore lint/security/noSecrets: a DOM selector, not a secret.
	const input = document.querySelector('input[type="file"]');
	if (!(input instanceof HTMLInputElement)) throw new Error("no file input");

	return input;
}

function renderModal() {
	return render(
		<MantineProvider>
			<ProfileModal
				open
				onClose={() => {}}
				token="tok"
				user={{ id: "a:test", nick: "alice" }}
			/>
		</MantineProvider>,
	);
}

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

		renderModal();

		const file = new File(["x"], "a.png", { type: "image/png" });
		fireEvent.change(fileInput(), { target: { files: [file] } });

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

	it("rejects a non-image file before uploading it", async () => {
		renderModal();

		const file = new File(["x"], "notes.txt", { type: "text/plain" });
		fireEvent.change(fileInput(), { target: { files: [file] } });

		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("rejects an oversized avatar before uploading it", async () => {
		renderModal();

		const file = new File(["x"], "big.png", { type: "image/png" });
		Object.defineProperty(file, "size", { value: 6 * 1024 * 1024 });
		fireEvent.change(fileInput(), { target: { files: [file] } });

		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("shows a localized error when the server rejects the avatar", async () => {
		vi.mocked(uploadFile).mockRejectedValue(new Error("http 413"));
		renderModal();

		const file = new File(["x"], "a.png", { type: "image/png" });
		fireEvent.change(fileInput(), { target: { files: [file] } });

		expect(await screen.findByRole("alert")).toBeTruthy();
	});
});
