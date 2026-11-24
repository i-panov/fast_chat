import { ActionIcon, Text, Tooltip } from "@mantine/core";
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
}

// eslint-disable-next-line max-lines-per-function -- permission handling, recording lifecycle and two button states share one media stream.
export function VoiceRecorderButton({ onAttachFiles }: Props) {
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

		// Checked before mediaDevices: the browser hides that object outside
		// a secure context, and "unsupported" would be the wrong advice.
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

		requestInFlightRef.current = true;
		const requestId = requestIdRef.current + 1;
		requestIdRef.current = requestId;
		setRequesting(true);

		try {
			const stream = await requestStream(requestId);
			if (stream === null) {
				if (requestId === requestIdRef.current) {
					setRequesting(false);
					requestInFlightRef.current = false;
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
				emitNotification(t(RECORD_FAILED_KEY));
			};
			recorder.onstop = () => {
				const duration = secondsRef.current;
				const type = recorder.mimeType || "audio/webm";
				const blob = new Blob(chunksRef.current, { type });
				cleanup();
				setRecording(false);
				setRequesting(false);

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
			setSeconds(0);
			setRequesting(false);
			setRecording(true);
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
				emitNotification(t(recordingErrorKey(error)));
			}
		}
	}

	function stop() {
		if (recorderRef.current?.state === "recording") {
			recorderRef.current.stop();
		}
	}

	if (requesting) {
		return (
			<Tooltip label={t("input.requestingMic")}>
				<ActionIcon
					variant="subtle"
					color="gray"
					size="lg"
					loading
					disabled
					style={{ marginBottom: 2 }}
					aria-label={t("input.requestingMic")}
				>
					<Mic size={20} />
				</ActionIcon>
			</Tooltip>
		);
	}

	if (recording) {
		return (
			<Tooltip label={t("input.stopRecording")}>
				<ActionIcon
					variant="filled"
					color="red"
					size="lg"
					onClick={stop}
					style={{ marginBottom: 2 }}
					aria-label={t("input.stopRecording")}
				>
					<Square size={16} />
					<Text size="xs" style={{ marginLeft: 4 }}>
						{seconds}
					</Text>
				</ActionIcon>
			</Tooltip>
		);
	}

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
