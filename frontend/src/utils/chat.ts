import type { Chat, Location, MemberInfo } from "../api.ts";
import { getCurrentLocale, default as i18n } from "../i18n.ts";

export function otherNick(members: MemberInfo[], myId: string): string {
	return members.find((m) => m.id !== myId)?.nick ?? i18n.t("chat.unknownUser");
}

export function chatTitle(chat: Chat, myId: string): string {
	if (chat.type === "group") {
		return chat.name || i18n.t("chat.groupFallback");
	}
	return otherNick(chat.members, myId);
}

export function formatDateLabel(isoStr: string, locale?: string): string {
	const d = new Date(isoStr);
	const today = new Date();
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);

	const loc = locale ?? getCurrentLocale();
	const fmt: Intl.DateTimeFormatOptions = {
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
	};
	const dStr = d.toLocaleDateString(loc, fmt);
	const todayStr = today.toLocaleDateString(loc, fmt);
	const yesterdayStr = yesterday.toLocaleDateString(loc, fmt);

	if (dStr === todayStr) return i18n.t("date.today");
	if (dStr === yesterdayStr) return i18n.t("date.yesterday");
	return dStr;
}

export function formatTime(isoStr: string, locale?: string): string {
	const d = new Date(isoStr);
	const loc = locale ?? getCurrentLocale();
	return d.toLocaleTimeString(loc, {
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function extractCodeText(children: unknown): string {
	if (typeof children === "string") return children;
	if (Array.isArray(children)) return children.map(String).join("");
	return String(children);
}

export function formatCoords(loc: Location): string {
	const lat = loc.lat.toFixed(6);
	const lng = loc.lng.toFixed(6);
	return `${lat}, ${lng}`;
}

export function openStreetMapURL(loc: Location): string {
	return `https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=17/${loc.lat}/${loc.lng}`;
}
