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

		audio.src = currentTrack.url;
		audio
			.play()
			.then(() => setIsPlaying(true))
			.catch(() => {
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
			} else {
				audio
					?.play()
					.then(() => setIsPlaying(true))
					.catch(() => {
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
		audio
			.play()
			.then(() => setIsPlaying(true))
			.catch(() => {
				setIsPlaying(false);
			});
	}, [currentTrack]);

	const stop = useCallback(() => {
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
