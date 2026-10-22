import { Button, Group, Paper, Stack, Text } from "@mantine/core";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

interface Props {
	open: boolean;
	peerNick: string;
	localStream: MediaStream | undefined;
	remoteStream: MediaStream | undefined;
	muted: boolean;
	cameraOn: boolean;
	onToggleMute: () => void;
	onToggleCamera: () => void;
	onHangup: () => void;
}

// Stream shows the media of one side of the call. The stream of the browser
// is not a source of the page: it is attached to the element directly.
function Stream({
	stream,
	muted,
	label,
	width,
}: {
	stream: MediaStream | undefined;
	muted: boolean;
	label: string;
	width: string;
}) {
	const ref = useRef<HTMLVideoElement | null>(null);

	useEffect(() => {
		if (ref.current) {
			ref.current.srcObject = stream ?? null;
		}
	}, [stream]);

	return (
		<video
			ref={ref}
			autoPlay
			playsInline
			muted={muted}
			aria-label={label}
			style={{ width, borderRadius: 8, background: "black" }}
		/>
	);
}

// ActiveCallOverlay is the panel of the call that is going on: the media of
// the other side, the own preview and the buttons of the call.
export function ActiveCallOverlay({
	open,
	peerNick,
	localStream,
	remoteStream,
	muted,
	cameraOn,
	onToggleMute,
	onToggleCamera,
	onHangup,
}: Props) {
	const { t } = useTranslation();

	if (!open) return null;

	return (
		<Paper p="md" withBorder>
			<Stack>
				<Text fw={600}>{t("call.with", { nick: peerNick })}</Text>
				<Stream
					stream={remoteStream}
					muted={false}
					label={t("call.remoteVideo")}
					width="100%"
				/>
				{cameraOn && (
					<Stream
						stream={localStream}
						muted={true}
						label={t("call.localVideo")}
						width="40%"
					/>
				)}
				<Group>
					<Button variant="light" onClick={onToggleMute}>
						{muted ? t("call.unmute") : t("call.mute")}
					</Button>
					<Button variant="light" onClick={onToggleCamera}>
						{cameraOn ? t("call.cameraOff") : t("call.cameraOn")}
					</Button>
					<Button color="red" onClick={onHangup}>
						{t("call.hangup")}
					</Button>
				</Group>
			</Stack>
		</Paper>
	);
}
