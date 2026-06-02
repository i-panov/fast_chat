import { describe, expect, it, vi } from "vitest";

vi.mock("../i18n.ts", () => ({
	default: {
		t: (key: string) => {
			const map: Record<string, string> = {
				"date.today": "Today",
				"date.yesterday": "Yesterday",
				"chat.unknownUser": "Unknown",
				"chat.groupFallback": "Group",
			};
			return map[key] ?? key;
		},
	},
}));

const { otherNick, formatDateLabel, extractCodeText, chatTitle } = await import(
	"./chat.ts"
);

describe("otherNick", () => {
	it("returns the other member's nick", () => {
		const members = [
			{ id: "alice:test", nick: "alice" },
			{ id: "bob:test", nick: "bob" },
		];
		expect(otherNick(members, "alice:test")).toBe("bob");
	});

	it("returns Unknown when no other member found", () => {
		const members = [{ id: "alice:test", nick: "alice" }];
		expect(otherNick(members, "alice:test")).toBe("Unknown");
	});

	it("returns Unknown for empty members", () => {
		expect(otherNick([], "alice:test")).toBe("Unknown");
	});
});

describe("formatDateLabel", () => {
	it('returns "Today" for today\'s date', () => {
		const today = new Date();
		expect(formatDateLabel(today.toISOString())).toBe("Today");
	});

	it('returns "Yesterday" for yesterday\'s date', () => {
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		expect(formatDateLabel(yesterday.toISOString())).toBe("Yesterday");
	});

	it("returns formatted date for older dates", () => {
		const date = new Date("2024-01-15T12:00:00Z");
		const result = formatDateLabel(date.toISOString());
		expect(result).toMatch(/\d{2}\.\d{2}\.\d{4}/);
	});
});

describe("extractCodeText", () => {
	it("returns string directly", () => {
		expect(extractCodeText("hello")).toBe("hello");
	});

	it("joins array of children", () => {
		expect(extractCodeText(["hello", " ", "world"])).toBe("hello world");
	});

	it("converts non-string to string", () => {
		expect(extractCodeText(42)).toBe("42");
	});
});

describe("chatTitle", () => {
	it("returns other nick for private chat", () => {
		const chat = {
			id: "c1",
			type: "private" as const,
			name: "",
			ownerId: "",
			members: [
				{ id: "alice", nick: "alice" },
				{ id: "bob", nick: "bob" },
			],
			createdAt: "",
		};
		expect(chatTitle(chat, "alice")).toBe("bob");
	});

	it("returns group name for group chat", () => {
		const chat = {
			id: "c1",
			type: "group" as const,
			name: "Team",
			ownerId: "alice",
			members: [
				{ id: "alice", nick: "alice" },
				{ id: "bob", nick: "bob" },
			],
			createdAt: "",
		};
		expect(chatTitle(chat, "alice")).toBe("Team");
	});

	it("falls back to 'Group' when group name is empty", () => {
		const chat = {
			id: "c1",
			type: "group" as const,
			name: "",
			ownerId: "alice",
			members: [{ id: "alice", nick: "alice" }],
			createdAt: "",
		};
		expect(chatTitle(chat, "alice")).toBe("Group");
	});
});
