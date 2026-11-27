import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../useAuth.tsx";
import { LoginPage } from "./LoginPage.tsx";

const navigate = vi.hoisted(() => vi.fn());

const DEBUG_CODE_TEXT = /123456/;
const BACK_TO_CHAT = /backToChat|Back to chat/;
const NICK_PLACEHOLDER = /Nickname|Никнейм/;
const LOCALIZED_CODE_ERROR =
	/Invalid or expired code|Неверный или истёкший код/;
const RESEND_WITH_COOLDOWN = /Send Code \(\d+\)/;
const EMAIL_LABEL = /Email|Эл\. почта/;
const RAW_HTTP_ERROR = /http 401/;

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-router")>();
	return { ...actual, useNavigate: () => navigate };
});

vi.mock("../api.ts", () => ({
	sendCode: vi.fn(),
	verifyCode: vi.fn(),
	completeRegistration: vi.fn(),
}));

const { sendCode, verifyCode, completeRegistration } = await import(
	"../api.ts"
);

function renderPage() {
	return render(
		<MantineProvider>
			<AuthProvider>
				<LoginPage />
			</AuthProvider>
		</MantineProvider>,
	);
}

function input(): HTMLInputElement {
	const el = document.querySelector("input");
	if (!(el instanceof HTMLInputElement)) throw new Error("no input");

	return el;
}

function submit(): HTMLButtonElement {
	const buttons = [...document.querySelectorAll("button")];
	const btn = buttons[buttons.length - 1];
	if (!(btn instanceof HTMLButtonElement)) throw new Error("no submit");

	return btn;
}

afterEach(async () => {
	// Mantine transitions schedule a timer on unmount; let it fire while jsdom
	// still provides window instead of leaking into the next test file.
	await new Promise((resolve) => setTimeout(resolve, 50));
});

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	vi.clearAllMocks();
});

describe("login page", () => {
	it("sends a code and shows the debug code", async () => {
		vi.mocked(sendCode).mockResolvedValue({
			status: "ok",
			debugCode: "123456",
		});
		renderPage();

		fireEvent.change(input(), { target: { value: "A@Example.com " } });
		fireEvent.click(submit());

		await waitFor(() => {
			expect(sendCode).toHaveBeenCalledWith("a@example.com");
		});
		expect(await screen.findByText(DEBUG_CODE_TEXT)).toBeTruthy();
	});

	it("shows an error when sending fails", async () => {
		vi.mocked(sendCode).mockRejectedValueOnce(new Error("smtp down"));
		renderPage();

		fireEvent.change(input(), { target: { value: "a@example.com" } });
		fireEvent.click(submit());

		expect(await screen.findByText("smtp down")).toBeTruthy();
	});

	it("logs in an existing account", async () => {
		vi.mocked(sendCode).mockResolvedValue({ status: "ok" });
		vi.mocked(verifyCode).mockResolvedValue({
			isNew: false,
			user: { id: "a:test", nick: "alice", online: true },
			token: "tok",
			expiresAt: "2027-01-01T00:00:00Z",
			sessionId: "s1",
			deviceId: "dev-1",
		});
		renderPage();

		fireEvent.change(input(), { target: { value: "a@example.com" } });
		fireEvent.click(submit());

		const code = await screen.findByDisplayValue("");
		fireEvent.change(code, { target: { value: "12ab34" } });
		expect((code as HTMLInputElement).value).toBe("1234");
		fireEvent.change(code, { target: { value: "123456" } });
		fireEvent.click(submit());

		await waitFor(() => {
			expect(navigate).toHaveBeenCalledWith({
				to: "/chat",
				search: { chatId: undefined, threadId: undefined },
			});
		});
		const call = vi.mocked(verifyCode).mock.calls[0];
		expect(typeof call?.[2]?.deviceId).toBe("string");
		expect(typeof call?.[2]?.deviceName).toBe("string");
		expect(localStorage.getItem("accounts")).toContain("tok");
		expect(localStorage.getItem("accounts")).toContain("s1");
	});

	it("registers a new account through the nick step", async () => {
		vi.mocked(sendCode).mockResolvedValue({ status: "ok" });
		vi.mocked(verifyCode).mockResolvedValue({ isNew: true, setupToken: "st" });
		vi.mocked(completeRegistration).mockResolvedValue({
			token: "tok2",
			user: { id: "b:test", nick: "bob", online: true },
			expiresAt: "2027-01-01T00:00:00Z",
		});
		renderPage();

		fireEvent.change(input(), { target: { value: "b@example.com" } });
		fireEvent.click(submit());

		const code = await screen.findByDisplayValue("");
		fireEvent.change(code, { target: { value: "654321" } });
		fireEvent.click(submit());

		const nick = await screen.findByPlaceholderText(NICK_PLACEHOLDER);
		fireEvent.change(nick, { target: { value: "bob" } });
		fireEvent.click(submit());

		await waitFor(() => {
			const call = vi.mocked(completeRegistration).mock.calls[0];
			expect(call?.[0]).toBe("st");
			expect(call?.[1]).toBe("bob");
			expect(typeof call?.[2]?.deviceId).toBe("string");
			expect(typeof call?.[2]?.deviceName).toBe("string");
			expect(navigate).toHaveBeenCalledWith({
				to: "/chat",
				search: { chatId: undefined, threadId: undefined },
			});
		});
	});

	it("shows verify and register errors", async () => {
		vi.mocked(sendCode).mockResolvedValue({ status: "ok" });
		vi.mocked(verifyCode).mockRejectedValueOnce(new Error("bad code"));
		renderPage();

		fireEvent.change(input(), { target: { value: "a@example.com" } });
		fireEvent.click(submit());

		const code = await screen.findByDisplayValue("");
		fireEvent.change(code, { target: { value: "000000" } });
		fireEvent.click(submit());

		expect(await screen.findByText("bad code")).toBeTruthy();
	});

	it("localizes a rejected code instead of showing the raw server text", async () => {
		vi.mocked(sendCode).mockResolvedValue({ status: "ok" });
		// The 401 of verify-code carries only an English body.
		vi.mocked(verifyCode).mockRejectedValueOnce(
			Object.assign(new Error("http 401: invalid code"), { status: 401 }),
		);
		renderPage();

		fireEvent.change(input(), { target: { value: "a@example.com" } });
		fireEvent.click(submit());

		const code = await screen.findByDisplayValue("");
		fireEvent.change(code, { target: { value: "000000" } });
		fireEvent.click(submit());

		expect(await screen.findByText(LOCALIZED_CODE_ERROR)).toBeTruthy();
		expect(screen.queryByText(RAW_HTTP_ERROR)).toBeNull();
	});

	it("offers resend and going back to the email step", async () => {
		vi.mocked(sendCode).mockResolvedValue({ status: "ok" });
		renderPage();

		fireEvent.change(input(), { target: { value: "a@example.com" } });
		fireEvent.click(submit());

		// The resend is disabled during its cooldown.
		const resend = await screen.findByRole("button", {
			name: RESEND_WITH_COOLDOWN,
		});
		expect(resend).toHaveProperty("disabled", true);

		fireEvent.click(screen.getByRole("button", { name: EMAIL_LABEL }));

		expect(await screen.findByPlaceholderText(EMAIL_LABEL)).toBeTruthy();
	});

	it("marks the code field as a one-time code", async () => {
		vi.mocked(sendCode).mockResolvedValue({ status: "ok" });
		renderPage();

		fireEvent.change(input(), { target: { value: "a@example.com" } });
		fireEvent.click(submit());

		const code = await screen.findByDisplayValue("");
		expect(code.getAttribute("inputmode")).toBe("numeric");
		expect(code.getAttribute("autocomplete")).toBe("one-time-code");
	});

	it("offers a way back when already logged in", async () => {
		localStorage.setItem(
			"accounts",
			JSON.stringify([
				{
					token: "tok",
					user: { id: "a:test", nick: "alice" },
					email: "a@example.com",
					expiresAt: "2027-01-01T00:00:00Z",
				},
			]),
		);
		sessionStorage.setItem("activeToken", "tok");
		renderPage();

		const back = await screen.findByText(BACK_TO_CHAT);
		fireEvent.click(back);

		expect(navigate).toHaveBeenCalledWith({
			to: "/chat",
			search: { chatId: undefined, threadId: undefined },
		});
	});
});
