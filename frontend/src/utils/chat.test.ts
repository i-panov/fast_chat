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

const {
	otherNick,
	extractCodeText,
	chatTitle,
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
