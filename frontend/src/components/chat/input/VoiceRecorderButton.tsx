import { ActionIcon, Button, Group, Text, Tooltip } from "@mantine/core";
import { Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { emitNotification } from "../../../utils/notify.ts";

const MAX_RECORD_SECONDS = 300;
// getUserMedia waits for the permission prompt: a dismissed prompt leaves the
// promise pending forever, so the button must give up and explain itself.
const PERMISSION_TIMEOUT_MS = 15_000;
const RECORD_FAILED_KEY = "input.recordFailed";

const PREFERRED_MIME_TYPES = [
	"audio/webm;codecs=opus",
	"audio/webm",
	"audio/mp4",
	"audio/ogg",
] as const;

function extensionFor(mimeType: string): string {
	if (mimeType.includes("ogg")) return "ogg";
	if (mimeType.includes("mp4")) return "m4a";
	return "webm";
}

function pickMimeType(): string | undefined {
	return PREFERRED_MIME_TYPES.find((type) =>
		MediaRecorder.isTypeSupported(type),
	);
}

function formatDuration(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;

	return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/** Maps a getUserMedia failure to a message the user can act on. */
function recordingErrorKey(error: unknown): string {
	if (error instanceof DOMException) {
		switch (error.name) {
			case "NotAllowedError":
			case "SecurityError":
				return "input.recordDenied";
			case "NotFoundError":
			case "OverconstrainedError":
				return "input.recordNoDevice";
			case "NotReadableError":
			case "AbortError":
				return "input.recordBusy";
			default:
				return RECORD_FAILED_KEY;
		}
	}

	return RECORD_FAILED_KEY;
}

function stopTracks(stream: MediaStream | null): void {
	if (stream === null) return;
	for (const track of stream.getTracks()) track.stop();
}

interface Props {
	onAttachFiles?: (files: File[]) => void | Promise<void>;
	/** Tells the composer to hide the input and attachments while recording. */
	onRecordingChange?: (recording: boolean) => void;
	/** Idle trigger is hidden when there is something to send. */
	hidden?: boolean;
}

// The recorder owns the whole composer row while it is active: the text
// input, the attach menu and the send button disappear, and a timer with
// Cancel/Send takes their place. The component stays mounted across the
// transition, so the MediaRecorder and the stream survive the layout change.
// eslint-disable-next-line max-lines-per-function -- the recorder owns the permission, MediaRecorder and composer states.
export function VoiceRecorderButton({
	onAttachFiles,
	onRecordingChange,
	hidden = false,
}: Props) {
	const { t } = useTranslation();
	const [requesting, setRequesting] = useState(false);
	const [recording, setRecording] = useState(false);
	const [seconds, setSeconds] = useState(0);
	const recorderRef = useRef<MediaRecorder | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const secondsRef = useRef(0);
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const requestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Identifies the permission request that is currently allowed to start a
	// recorder; a late answer of an older or unmounted request is discarded.
	const requestIdRef = useRef(0);
	const requestInFlightRef = useRef(false);
	const discardRef = useRef(false);

	useEffect(() => {
		return () => {
			requestIdRef.current += 1;
			if (timerRef.current !== null) clearInterval(timerRef.current);
			if (requestTimerRef.current !== null) {
				clearTimeout(requestTimerRef.current);
			}
			const recorder = recorderRef.current;
			if (recorder?.state === "recording") {
				recorder.onstop = null;
				recorder.stop();
			}
			stopTracks(streamRef.current);
		};
	}, []);

	function cleanup() {
		if (timerRef.current !== null) {
			clearInterval(timerRef.current);
			timerRef.current = null;
		}
		if (requestTimerRef.current !== null) {
			clearTimeout(requestTimerRef.current);
			requestTimerRef.current = null;
		}
		stopTracks(streamRef.current);
		streamRef.current = null;
		recorderRef.current = null;
		requestInFlightRef.current = false;
	}

	async function requestStream(requestId: number): Promise<MediaStream | null> {
		const request = navigator.mediaDevices.getUserMedia({ audio: true });
		let timedOut = false;

		const timeout = new Promise<null>((resolve) => {
			requestTimerRef.current = setTimeout(() => {
				timedOut = true;
				resolve(null);
			}, PERMISSION_TIMEOUT_MS);
		});

		// The prompt cannot be cancelled: if it is answered after the timeout,
		// the tracks it grants must be released instead of staying open.
		void request.then(
			(stream) => {
				if (timedOut) stopTracks(stream);
			},
			() => undefined,
		);

		const stream = await Promise.race([request, timeout]);
		if (requestTimerRef.current !== null) {
			clearTimeout(requestTimerRef.current);
			requestTimerRef.current = null;
		}

		if (stream !== null && requestId !== requestIdRef.current) {
			stopTracks(stream);
			return null;
		}

		return stream;
	}

	async function start() {
		if (requestInFlightRef.current || recorderRef.current !== null) return;

		if (window.isSecureContext === false) {
			emitNotification(t("input.recordInsecure"));
			return;
		}

		if (
			typeof MediaRecorder === "undefined" ||
			navigator.mediaDevices?.getUserMedia === undefined ||
			onAttachFiles === undefined
		) {
			emitNotification(t("input.recordUnsupported"));
			return;
		}

		discardRef.current = false;
		requestInFlightRef.current = true;
		const requestId = requestIdRef.current + 1;
		requestIdRef.current = requestId;
		setRequesting(true);
		onRecordingChange?.(true);

		try {
			const stream = await requestStream(requestId);
			if (stream === null) {
				if (requestId === requestIdRef.current) {
					setRequesting(false);
					requestInFlightRef.current = false;
					onRecordingChange?.(false);
					emitNotification(t("input.recordTimeout"));
				}
				return;
			}

			// Register the stream before the constructor: if it throws (an
			// unsupported mime type), the catch must be able to stop the
			// microphone tracks.
			streamRef.current = stream;
			const mimeType = pickMimeType();
			const recorder = new MediaRecorder(
				stream,
				mimeType === undefined ? undefined : { mimeType },
			);

			chunksRef.current = [];
			secondsRef.current = 0;
			recorder.ondataavailable = (event) => {
				if (event.data.size > 0) chunksRef.current.push(event.data);
			};
			recorder.onerror = () => {
				cleanup();
				setRecording(false);
				setRequesting(false);
				onRecordingChange?.(false);
				emitNotification(t(RECORD_FAILED_KEY));
			};
			recorder.onstop = () => {
				const duration = secondsRef.current;
				const type = recorder.mimeType || "audio/webm";
				const blob = new Blob(chunksRef.current, { type });
				const discarded = discardRef.current;
				discardRef.current = false;
				cleanup();
				setRecording(false);
				setRequesting(false);
				onRecordingChange?.(false);

				if (discarded) return;

				if (blob.size === 0) {
					emitNotification(t(RECORD_FAILED_KEY));
					return;
				}

				if (duration < 1) {
					emitNotification(t("input.recordTooShort"));
					return;
				}

				const file = new File(
					[blob],
					`voice-${duration}s.${extensionFor(type)}`,
					{ type },
				);
				Promise.resolve(onAttachFiles([file])).catch(() => {
					emitNotification(t("input.recordAttachFailed"));
				});
			};

			recorderRef.current = recorder;
			requestInFlightRef.current = false;
			setRequesting(false);
			setSeconds(0);
			setRecording(true);
			onRecordingChange?.(true);
			recorder.start();
			timerRef.current = setInterval(() => {
				secondsRef.current += 1;
				setSeconds(secondsRef.current);
				if (secondsRef.current >= MAX_RECORD_SECONDS) {
					recorder.stop();
				}
			}, 1000);
		} catch (error) {
			cleanup();
			setRecording(false);
			setRequesting(false);
			if (requestId === requestIdRef.current) {
				onRecordingChange?.(false);
				emitNotification(t(recordingErrorKey(error)));
			}
		}
	}

	function stop() {
		if (recorderRef.current?.state === "recording") {
			recorderRef.current.stop();
		}
	}

	function cancel() {
		discardRef.current = true;
		if (recorderRef.current?.state === "recording") {
			recorderRef.current.stop();
			return;
		}

		// A pending permission prompt cannot be cancelled: invalidate it so
		// the late stream is stopped instead of starting a recorder.
		requestIdRef.current += 1;
		cleanup();
		setRequesting(false);
		setRecording(false);
		onRecordingChange?.(false);
	}

	if (requesting || recording) {
		return (
			<Group
				justify="space-between"
				align="center"
				gap="xs"
				style={{ flex: 1, minWidth: 0 }}
			>
				<Group gap="xs" align="center" wrap="nowrap">
					<span
						style={{
							width: 10,
							height: 10,
							borderRadius: "50%",
							flexShrink: 0,
							background: "var(--mantine-color-red-6)",
						}}
					/>
					<Text
						size="sm"
						fw={600}
						style={{ fontVariantNumeric: "tabular-nums" }}
					>
						{formatDuration(seconds)}
					</Text>
					<Text size="xs" c="dimmed" truncate>
						{t(requesting ? "input.requestingMic" : "input.recording")}
					</Text>
				</Group>
				<Group gap="xs" wrap="nowrap">
					<Button
						type="button"
						variant="subtle"
						color="gray"
						size="compact-sm"
						onClick={cancel}
					>
						{t("input.cancel")}
					</Button>
					{recording && (
						<Button
							type="button"
							color="red"
							size="compact-sm"
							leftSection={<Square size={12} />}
							onClick={stop}
						>
							{t("input.send")}
						</Button>
					)}
				</Group>
			</Group>
		);
	}

	if (hidden) return null;

	return (
		<Tooltip label={t("input.recordVoice")}>
			<ActionIcon
				variant="subtle"
				color="gray"
				size="lg"
				onClick={() => {
					void start();
				}}
				style={{ marginBottom: 2 }}
				aria-label={t("input.recordVoice")}
			>
				<Mic size={20} />
			</ActionIcon>
		</Tooltip>
	);
}
