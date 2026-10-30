import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";

export interface AudioTrack {
	fileId: string;
	url: string;
	name: string;
}

interface AudioPlayerContextValue {
	currentTrack: AudioTrack | null;
	isPlaying: boolean;
	play: (track: AudioTrack) => void;
	pause: () => void;
	resume: () => void;
	stop: () => void;
	toggle: () => void;
}

const AudioPlayerContext = createContext<AudioPlayerContextValue | null>(null);

export function AudioProvider({ children }: { children: ReactNode }) {
	const [currentTrack, setCurrentTrack] = useState<AudioTrack | null>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const currentTrackRef = useRef(currentTrack);
	const generationRef = useRef(0);
	useEffect(() => {
		currentTrackRef.current = currentTrack;
	}, [currentTrack]);

	useEffect(() => {
		audioRef.current = new Audio();

		return () => {
			audioRef.current?.pause();
			audioRef.current = null;
		};
	}, []);

	useEffect(() => {
		const audio = audioRef.current;
		if (!audio) return;

		if (currentTrack === null) {
			audio.pause();
			audio.src = "";
			setIsPlaying(false);

			return;
		}

		const generation = generationRef.current + 1;
		generationRef.current = generation;
		const fileId = currentTrack.fileId;

		audio.src = currentTrack.url;
		audio
			.play()
			.then(() => {
				if (generationRef.current !== generation) return;
				if (currentTrackRef.current?.fileId !== fileId) return;
				setIsPlaying(true);
			})
			.catch(() => {
				if (generationRef.current !== generation) return;
				setIsPlaying(false);
			});
	}, [currentTrack]);

	useEffect(() => {
		const audio = audioRef.current;
		if (!audio) return;

		const onEnded = () => {
			setIsPlaying(false);
		};

		audio.addEventListener("ended", onEnded);

		return () => audio.removeEventListener("ended", onEnded);
	}, []);

	const play = useCallback((track: AudioTrack) => {
		const prev = currentTrackRef.current;
		if (prev?.fileId === track.fileId) {
			const audio = audioRef.current;
			if (audio && !audio.paused) {
				audio.pause();
				setIsPlaying(false);
			} else if (audio) {
				// A track that played to the end stays at its end: rewind
				// before the replay, or it stays silent.
				if (audio.ended) {
					try {
						audio.currentTime = 0;
					} catch {
						// A browser that refuses the seek plays from the end.
					}
				}
				const generation = generationRef.current + 1;
				generationRef.current = generation;
				const fileId = track.fileId;
				audio
					?.play()
					.then(() => {
						if (generationRef.current !== generation) return;
						if (currentTrackRef.current?.fileId !== fileId) return;
						setIsPlaying(true);
					})
					.catch(() => {
						if (generationRef.current !== generation) return;
						setIsPlaying(false);
					});
			}
			return;
		}
		setCurrentTrack(track);
	}, []);

	const pause = useCallback(() => {
		audioRef.current?.pause();
		setIsPlaying(false);
	}, []);

	const resume = useCallback(() => {
		const audio = audioRef.current;
		if (!audio || !currentTrack) return;
		const generation = generationRef.current + 1;
		generationRef.current = generation;
		const fileId = currentTrack.fileId;
		audio
			.play()
			.then(() => {
				if (generationRef.current !== generation) return;
				if (currentTrackRef.current?.fileId !== fileId) return;
				setIsPlaying(true);
			})
			.catch(() => {
				if (generationRef.current !== generation) return;
				setIsPlaying(false);
			});
	}, [currentTrack]);

	const stop = useCallback(() => {
		generationRef.current += 1;
		audioRef.current?.pause();
		if (audioRef.current) audioRef.current.src = "";
		setCurrentTrack(null);
		setIsPlaying(false);
	}, []);

	const toggle = useCallback(() => {
		if (isPlaying) {
			pause();
		} else {
			resume();
		}
	}, [isPlaying, pause, resume]);

	return (
		<AudioPlayerContext.Provider
			value={{ currentTrack, isPlaying, play, pause, resume, stop, toggle }}
		>
			{children}
		</AudioPlayerContext.Provider>
	);
}

export function useAudioPlayer() {
	const ctx = useContext(AudioPlayerContext);
	if (!ctx) {
		throw new Error("useAudioPlayer must be used within AudioProvider");
	}

	return ctx;
}

// Note: the player never revokes track URLs. Tracks reference object URLs
// owned by the attachments (useDecryptedFileUrl/fileCache), which revoke
// them on unmount; revokeObjectURL is global, so revoking here would break
// the owner's copy and poison the shared fileCache entry.
