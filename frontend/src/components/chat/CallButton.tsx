import { ActionIcon, Tooltip } from "@mantine/core";
import { Phone } from "lucide-react";
import { useTranslation } from "react-i18next";

interface Props {
	peer: { id: string; nick: string } | undefined;
	localUserId: string;
	disabled: boolean;
	onCall: () => void;
}

// domainOf returns the server part of a user identifier ("nick:domain").
function domainOf(userId: string): string {
	const index = userId.indexOf(":");

	return index === -1 ? "" : userId.slice(index + 1);
}

// CallButton starts a call in a private chat. It is hidden when the call is
// impossible: a group chat, a call to oneself or a peer on another server.
export function CallButton({ peer, localUserId, disabled, onCall }: Props) {
	const { t } = useTranslation();

	if (peer === undefined || peer.id === localUserId) return null;

	// A call is only possible between two users of the same server.
	if (domainOf(peer.id) !== domainOf(localUserId)) return null;

	return (
		<Tooltip label={t("call.start")} withArrow>
			<ActionIcon
				variant="subtle"
				color="green"
				disabled={disabled}
				onClick={onCall}
				aria-label={t("call.start")}
			>
				<Phone size={18} />
			</ActionIcon>
		</Tooltip>
	);
}
