import { ActionIcon } from "@mantine/core";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { FileInfo } from "../../api.ts";
import { useFileUrl } from "../../hooks/useFileUrl.ts";
import { useAuth } from "../../useAuth.tsx";

interface Props {
	images: FileInfo[];
	startIndex: number;
	onClose: () => void;
}

export function ImageLightbox({ images, startIndex, onClose }: Props) {
	const [index, setIndex] = useState(startIndex);
	const { activeAccount } = useAuth();

	const current = images[index];
	const { blobUrl, loading, error } = useFileUrl(
		current?.url,
		activeAccount?.token,
	);

	const goPrev = useCallback(() => {
		setIndex((i) => (i - 1 + images.length) % images.length);
	}, [images.length]);

	const goNext = useCallback(() => {
		setIndex((i) => (i + 1) % images.length);
	}, [images.length]);

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				onClose();
			} else if (e.key === "ArrowLeft" && images.length > 1) {
				goPrev();
			} else if (e.key === "ArrowRight" && images.length > 1) {
				goNext();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [images.length, onClose, goPrev, goNext]);

	if (images.length === 0) return null;

	return (
		// biome-ignore lint/a11y/noNoninteractiveElementInteractions: backdrop click closes dialog
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Image viewer"
			tabIndex={-1}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") onClose();
			}}
			style={{
				position: "fixed",
				inset: 0,
				zIndex: 2000,
				background: "rgba(0, 0, 0, 0.9)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				cursor: "pointer",
			}}
		>
			<ActionIcon
				variant="subtle"
				color="gray"
				size="xl"
				onClick={onClose}
				style={{
					position: "absolute",
					top: 16,
					right: 16,
					color: "white",
				}}
			>
				<X size={24} />
			</ActionIcon>

			{images.length > 1 && (
				<ActionIcon
					variant="subtle"
					color="gray"
					size="xl"
					onClick={(e) => {
						e.stopPropagation();
						goPrev();
					}}
					style={{
						position: "absolute",
						left: 16,
						top: "50%",
						transform: "translateY(-50%)",
						color: "white",
					}}
				>
					<ChevronLeft size={32} />
				</ActionIcon>
			)}

			{loading ? (
				<ActionIcon variant="subtle" color="gray" size="xl" loading />
			) : error || !blobUrl ? (
				<p style={{ color: "white" }}>Failed to load image</p>
			) : (
				<img
					src={blobUrl}
					alt={current.originalName}
					style={{
						maxWidth: "95vw",
						maxHeight: "90vh",
						objectFit: "contain",
					}}
				/>
			)}

			{images.length > 1 && (
				<ActionIcon
					variant="subtle"
					color="gray"
					size="xl"
					onClick={(e) => {
						e.stopPropagation();
						goNext();
					}}
					style={{
						position: "absolute",
						right: 16,
						top: "50%",
						transform: "translateY(-50%)",
						color: "white",
					}}
				>
					<ChevronRight size={32} />
				</ActionIcon>
			)}

			{images.length > 1 && (
				<div
					style={{
						position: "absolute",
						bottom: 16,
						left: "50%",
						transform: "translateX(-50%)",
						color: "white",
						fontSize: 14,
						background: "rgba(0, 0, 0, 0.5)",
						padding: "4px 12px",
						borderRadius: 4,
						pointerEvents: "none",
					}}
				>
					{index + 1} / {images.length}
				</div>
			)}
		</div>
	);
}
