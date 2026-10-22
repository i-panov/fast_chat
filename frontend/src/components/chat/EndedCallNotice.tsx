import { Button, Group, Paper, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { CallRole } from "../../types/api.ts";

interface Props {
	reason: string | undefined;
	// callRole tells which side of the call the user is on. It is not called
	// "role": that name belongs to the ARIA attributes.
	callRole: CallRole | undefined;
	peerNick: string;
	onDismiss: () => void;
}

// EndedCallNotice reports the call that ended without an answer. The two
// sides of a call know different things: the caller waits for an answer, the
// callee waits for the caller.
export function EndedCallNotice({
	reason,
	callRole,
	peerNick,
	onDismiss,
}: Props) {
	const { t } = useTranslation();

	if (reason === undefined || callRole === undefined) return null;

	let message: string | undefined;

	if (reason === "timeout") {
		message =
			callRole === "caller"
				? t("call.notAnswered")
				: t("call.missed", { nick: peerNick });
	} else if (reason === "peer-left" && callRole === "callee") {
		message = t("call.peerLeft");
	}

	// The end of a call both sides know about needs no report.
	if (message === undefined) return null;

	return (
		<Paper p="sm" withBorder>
			<Group justify="space-between" wrap="nowrap">
				<Text size="sm">{message}</Text>
				<Button variant="subtle" size="compact-xs" onClick={onDismiss}>
					{t("call.close")}
				</Button>
			</Group>
		</Paper>
	);
}
