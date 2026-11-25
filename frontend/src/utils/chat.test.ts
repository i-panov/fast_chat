import { describe, expect, it, vi } from "vitest";
import type { Chat } from "../types/api.ts";

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

const {
	otherNick,
	extractCodeText,
	chatTitle,
	chatPath,
	chatFromPath,
	privateChatRef,
	formatCoords,
	openStreetMapURL,
} = await import("./chat.ts");

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

describe("formatCoords", () => {
	it("formats coordinates with 6 decimal places", () => {
		expect(formatCoords({ lat: 51.505, lng: -0.09 })).toBe(
			"51.505000, -0.090000",
		);
	});

	it("keeps negative latitude formatting", () => {
		expect(formatCoords({ lat: -33.8688, lng: 151.2093 })).toBe(
			"-33.868800, 151.209300",
		);
	});

	it("keeps negative longitude formatting", () => {
		expect(formatCoords({ lat: 40.7128, lng: -74.006 })).toBe(
			"40.712800, -74.006000",
		);
	});
});

describe("formatCoords invalid", () => {
	it("returns a placeholder for NaN", () => {
		expect(formatCoords({ lat: Number.NaN, lng: 0 })).toBe("—");
	});

	it("returns a placeholder for string coords from the server", () => {
		expect(formatCoords({ lat: "51.5" as unknown as number, lng: -0.09 })).toBe(
			"—",
		);
	});

	it("returns a placeholder for out-of-range coords", () => {
		expect(formatCoords({ lat: 200, lng: 0 })).toBe("—");
	});
});

describe("extractCodeText elements", () => {
	it("extracts from React-element-like objects", () => {
		expect(extractCodeText({ props: { children: ["a", "b"] } })).toBe("ab");
	});

	it("returns empty for nullish", () => {
		expect(extractCodeText(null)).toBe("");
		expect(extractCodeText(undefined)).toBe("");
	});
});

describe("openStreetMapURL", () => {
	it("builds an OSM URL with mlat/mlon and map hash", () => {
		expect(openStreetMapURL({ lat: 51.505, lng: -0.09 })).toBe(
			"https://www.openstreetmap.org/?mlat=51.505&mlon=-0.09#map=17/51.505/-0.09",
		);
	});

	it("preserves sign on negative coordinates", () => {
		expect(openStreetMapURL({ lat: -33.8688, lng: 151.2093 })).toBe(
			"https://www.openstreetmap.org/?mlat=-33.8688&mlon=151.2093#map=17/-33.8688/151.2093",
		);
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

const privateChat: Chat = {
	id: "c1",
	type: "private",
	name: "",
	ownerId: "",
	members: [
		{ id: "alice", nick: "alice" },
		{ id: "root_bot", nick: "Root Bot", username: "root_bot" },
	],
	createdAt: "",
};

describe("chat paths", () => {
	it("builds a shareable path from the other member's username", () => {
		expect(privateChatRef(privateChat, "alice")).toBe("root_bot");
		expect(chatPath(privateChat, "alice")).toBe("/chat/root_bot");
	});

	it("uses the id when the other member has no username", () => {
		const chat = {
			...privateChat,
			members: [
				{ id: "alice", nick: "alice" },
				{ id: "bob:test", nick: "bob" },
			],
		};
		expect(chatPath(chat, "alice")).toBe("/chat/bob%3Atest");
	});

	it("uses dedicated paths for groups and favorites", () => {
		const group = { ...privateChat, id: "g:1", type: "group" as const };
		const self = { ...privateChat, id: "s:1", type: "self" as const };
		expect(chatPath(group, "alice")).toBe("/group/g%3A1");
		expect(chatPath(self, "alice")).toBe("/favorite");
	});

	it("resolves a path back to the chat", () => {
		const chats = [privateChat];
		expect(chatFromPath("/chat/@root_bot", chats, "alice")).toBe(privateChat);
		expect(chatFromPath("/chat/%40root_bot", chats, "alice")).toBe(privateChat);
		expect(chatFromPath("/chat/root_bot", chats, "alice")).toBe(privateChat);
		expect(chatFromPath("/chat/unknown", chats, "alice")).toBeUndefined();
		expect(chatFromPath("/chat", chats, "alice")).toBeUndefined();
	});

	it("resolves groups and favorites", () => {
		const group: Chat = { ...privateChat, id: "g:1", type: "group" };
		const self: Chat = { ...privateChat, id: "s:1", type: "self" };
		expect(chatFromPath("/group/g%3A1", [group], "alice")).toBe(group);
		expect(chatFromPath("/favorite", [self], "alice")).toBe(self);
	});
});
