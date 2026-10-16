import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../useAuth.tsx";
import { CreateGroupModal } from "./CreateGroupModal.tsx";

vi.mock("../../api.ts", () => ({
	searchUsers: vi.fn(),
}));

const { searchUsers } = await import("../../api.ts");

function seedAccount() {
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

function renderModal(props: {
	onCreate?: (name: string, ids: string[]) => void | Promise<void>;
	onClose?: () => void;
}) {
	return render(
		<MantineProvider>
			<AuthProvider>
				<CreateGroupModal
					open={true}
					onClose={props.onClose ?? (() => {})}
					onCreate={props.onCreate ?? (() => {})}
				/>
			</AuthProvider>
		</MantineProvider>,
	);
}

function textInputs(): HTMLInputElement[] {
	const inputs = [...document.querySelectorAll("input")].filter(
		(el): el is HTMLInputElement => el instanceof HTMLInputElement,
	);
	if (inputs.length < 2) throw new Error("inputs not rendered");

	// Name first, user search second — independent of i18n timing.
	return inputs;
}

function nameInput(): HTMLInputElement {
	return textInputs()[0];
}

function searchInput(): HTMLInputElement {
	return textInputs()[1];
}

function createButton(): HTMLButtonElement {
	const btn = [...document.querySelectorAll("button")].find((b) =>
		CREATE_BUTTON_TEXT.test(b.textContent ?? ""),
	);
	if (!(btn instanceof HTMLButtonElement)) throw new Error("no create button");

	return btn;
}

const BOB = { id: "bob:test", nick: "bob", online: true };

const CREATE_BUTTON_TEXT = /Create group|chat\.createGroup/;

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	seedAccount();
	vi.clearAllMocks();
	vi.mocked(searchUsers).mockResolvedValue({ users: [BOB] });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("CreateGroupModal", () => {
	it("searches, picks and creates a group", async () => {
		const onCreate = vi.fn();
		renderModal({ onCreate });

		fireEvent.change(nameInput(), { target: { value: "Team" } });
		fireEvent.change(searchInput(), { target: { value: "bo" } });

		await screen.findByText("@bob");
		expect(searchUsers).toHaveBeenCalledWith("tok", "bo");

		fireEvent.click(screen.getByText("@bob"));
		expect(screen.queryByText("@bob", { selector: "button *" })).toBeNull();

		fireEvent.click(createButton());

		await waitFor(() => {
			expect(onCreate).toHaveBeenCalledWith("Team", ["bob:test"]);
		});
	});

	it("unpicks a member", async () => {
		renderModal({});

		fireEvent.change(searchInput(), { target: { value: "bo" } });
		await screen.findByText("@bob");
		fireEvent.click(screen.getByText("@bob"));

		// The picked list shows a remove button per member.
		const remove = document.querySelector("button.mantine-ActionIcon-root");
		if (!remove) throw new Error("no remove button");
		fireEvent.click(remove);

		expect(screen.queryByText("@bob")).toBeNull();
	});

	it("clears results on empty query and handles lookup failure", async () => {
		vi.mocked(searchUsers).mockRejectedValueOnce(new Error("down"));
		renderModal({});

		fireEvent.change(searchInput(), { target: { value: "bo" } });

		await waitFor(() => {
			expect(searchUsers).toHaveBeenCalled();
		});
		expect(screen.queryByText("@bob")).toBeNull();

		fireEvent.change(searchInput(), { target: { value: "" } });
		expect(searchInput().value).toBe("");
	});

	it("does not search without an account", async () => {
		localStorage.clear();
		sessionStorage.clear();
		render(
			<MantineProvider>
				<AuthProvider>
					<CreateGroupModal
						open={true}
						onClose={() => {}}
						onCreate={() => {}}
					/>
				</AuthProvider>
			</MantineProvider>,
		);

		fireEvent.change(searchInput(), { target: { value: "bo" } });

		await new Promise((r) => setTimeout(r, 500));
		expect(searchUsers).not.toHaveBeenCalled();
	});
});
