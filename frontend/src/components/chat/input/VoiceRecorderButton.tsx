import { ActionIcon, Text, Tooltip } from "@mantine/core";
import { Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { emitNotification } from "../../../utils/notify.ts";

const MAX_RECORD_SECONDS = 300;

function extensionFor(mimeType: string): string {
	if (mimeType.includes("ogg")) return "ogg";
	if (mimeType.includes("mp4")) return "m4a";
	return "webm";
}

interface Props {
	onAttachFiles?: (files: File[]) => void | Promise<void>;
}

export function VoiceRecorderButton({ onAttachFiles }: Props) {
	const { t } = useTranslation();
	const [recording, setRecording] = useState(false);
	const [seconds, setSeconds] = useState(0);
	const recorderRef = useRef<MediaRecorder | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const secondsRef = useRef(0);
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

	useEffect(() => {
		return () => {
			if (timerRef.current !== null) clearInterval(timerRef.current);
			const recorder = recorderRef.current;
			if (recorder?.state === "recording") {
				recorder.onstop = null;
				recorder.stop();
			}
			const stream = streamRef.current;
			if (stream !== null) {
				for (const track of stream.getTracks()) track.stop();
			}
		};
	}, []);

	function cleanup() {
		if (timerRef.current !== null) {
			clearInterval(timerRef.current);
			timerRef.current = null;
		}
		const stream = streamRef.current;
		if (stream !== null) {
			for (const track of stream.getTracks()) track.stop();
		}
		streamRef.current = null;
		recorderRef.current = null;
	}

	async function start() {
		if (
			typeof MediaRecorder === "undefined" ||
			navigator.mediaDevices?.getUserMedia === undefined ||
			onAttachFiles === undefined
		) {
			emitNotification(t("input.recordUnsupported"));
			return;
		}

		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const recorder = new MediaRecorder(stream);
			chunksRef.current = [];
			recorder.ondataavailable = (event) => {
				if (event.data.size > 0) chunksRef.current.push(event.data);
			};
			recorder.onstop = () => {
				const duration = secondsRef.current;
				const mimeType = recorder.mimeType || "audio/webm";
				const blob = new Blob(chunksRef.current, { type: mimeType });
				cleanup();
				setRecording(false);
				if (blob.size === 0 || duration < 1) return;
				const file = new File(
					[blob],
					`voice-${duration}s.${extensionFor(mimeType)}`,
					{ type: mimeType },
				);
				void onAttachFiles([file]);
			};
			streamRef.current = stream;
			recorderRef.current = recorder;
			chunksRef.current = [];
			secondsRef.current = 0;
			setSeconds(0);
			setRecording(true);
			recorder.start();
			timerRef.current = setInterval(() => {
				secondsRef.current += 1;
				setSeconds(secondsRef.current);
				if (secondsRef.current >= MAX_RECORD_SECONDS) {
					recorder.stop();
				}
			}, 1000);
		} catch {
			cleanup();
			setRecording(false);
			emitNotification(t("input.recordFailed"));
		}
	}

	function stop() {
		if (recorderRef.current?.state === "recording") {
			recorderRef.current.stop();
		}
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
