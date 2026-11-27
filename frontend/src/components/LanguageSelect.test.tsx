import { MantineProvider } from "@mantine/core";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n.ts";
import { LanguageSelect } from "./LanguageSelect.tsx";

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn();
});

const SYSTEM_OPTION_RE = /System default|Как в системе/;

function renderSelect() {
	return render(
		<MantineProvider>
			<LanguageSelect />
		</MantineProvider>,
	);
}

afterEach(async () => {
	await i18n.changeLanguage("en");
	localStorage.clear();
});

describe("LanguageSelect", () => {
	it("offers the system default and both languages", async () => {
		renderSelect();

		const input = screen.getByRole("combobox");
		fireEvent.click(input);

		const listbox = await screen.findByRole("listbox");
		expect(within(listbox).getByText(SYSTEM_OPTION_RE)).toBeTruthy();
		expect(within(listbox).getByText("English")).toBeTruthy();
		expect(within(listbox).getByText("Русский")).toBeTruthy();
	});

	it("saves an explicit language choice", async () => {
		renderSelect();

		fireEvent.click(screen.getByRole("combobox"));
		const listbox = await screen.findByRole("listbox");
		fireEvent.click(within(listbox).getByText("Русский"));

		await waitFor(() => {
			expect(localStorage.getItem("fastchat.language")).toBe("ru");
			expect(i18n.language).toBe("ru");
		});
	});
});
