import { ActionIcon, Badge, Box, Group, Tooltip } from "@mantine/core";
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
// impossible: no peer, or a call to oneself. A peer on another server is
// still callable: the signaling goes through federation, and the button
// carries a badge saying so.
export function CallButton({ peer, localUserId, disabled, onCall }: Props) {
	const { t } = useTranslation();

	if (peer === undefined || peer.id === localUserId) return null;

	const isRemote = domainOf(peer.id) !== domainOf(localUserId);

	return (
		<Group gap={4} wrap="nowrap">
			{isRemote && (
				<Badge size="xs" variant="outline">
					{t("call.remoteBadge")}
				</Badge>
			)}
			<Tooltip label={t("call.start")} withArrow>
				{/* A disabled button does not emit the events the tooltip needs:
				    the wrapper keeps the hint available. */}
				<Box component="span" style={{ display: "inline-flex" }}>
					<ActionIcon
						variant="subtle"
						color="green"
						disabled={disabled}
						onClick={onCall}
						aria-label={t("call.start")}
					>
						<Phone size={18} />
					</ActionIcon>
				</Box>
			</Tooltip>
		</Group>
	);
}
