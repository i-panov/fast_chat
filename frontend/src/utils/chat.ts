import type { MemberInfo } from "../api.ts";
import i18n from "../i18n.ts";

export function otherNick(members: MemberInfo[], myId: string): string {
	return members.find((m) => m.id !== myId)?.nick ?? i18n.t("chat.unknownUser");
}

export function formatDateLabel(isoStr: string, locale?: string): string {
	const d = new Date(isoStr);
	const today = new Date();
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);

	const loc = locale ?? i18n.language.split("-")[0];
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
	const loc = locale ?? i18n.language.split("-")[0];
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
