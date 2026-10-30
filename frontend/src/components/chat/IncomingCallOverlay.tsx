import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatPageState } from "../../types/chat.ts";

interface Props {
	open: boolean;
	peerNick: string;
	onAccept: () => void;
	onReject: () => void;
	// onDismiss closes the window without declining the call: Escape and
	// outside clicks must not reject a call the user is about to accept.
	onDismiss?: () => void;
}

// IncomingCallOverlay is the window of the incoming call. The user takes the
// call himself: the camera is only asked for when he presses the button.
export function IncomingCallOverlay({
	open,
	peerNick,
	onAccept,
	onReject,
	onDismiss,
}: Props) {
	const { t } = useTranslation();

	return (
		<Modal
			opened={open}
			onClose={onDismiss ?? (() => {})}
			withCloseButton={false}
			centered
		>
			<Stack>
				<Text fw={600}>{t("call.incomingFrom", { nick: peerNick })}</Text>
				<Group>
					<Button color="green" onClick={onAccept}>
						{t("call.accept")}
					</Button>
					<Button color="red" variant="light" onClick={onReject}>
						{t("call.reject")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

// IncomingCallSection owns the snooze state of the incoming window:
// Escape/outside-click hides the modal without declining (the ringtone
// keeps ringing while the phase is incoming), and a banner button brings
// it back. A new callId reopens the modal; the snooze never survives
// the call.
export function IncomingCallSection({
	s,
	peerNick,
}: {
	s: ChatPageState;
	peerNick: string;
}) {
	const { t } = useTranslation();
	const [snoozedCallId, setSnoozedCallId] = useState<string | null>(null);
	const incomingCallId =
		s.call.phase === "incoming" ? (s.call.callId ?? null) : null;
	const showIncoming =
		incomingCallId !== null && snoozedCallId !== incomingCallId;

	return (
		<>
			<IncomingCallOverlay
				open={showIncoming}
				peerNick={peerNick}
				onAccept={() => {
					void s.acceptCall();
				}}
				onReject={() => {
					void s.rejectCall();
				}}
				onDismiss={() => {
					if (incomingCallId !== null) setSnoozedCallId(incomingCallId);
				}}
			/>
			{incomingCallId !== null && snoozedCallId === incomingCallId && (
				<div style={{ padding: "8px 16px" }}>
					<Button variant="light" fullWidth onClick={() => setSnoozedCallId(null)}>
						{t("call.incomingFrom", { nick: peerNick })}
					</Button>
				</div>
			)}
		</>
	);
}
