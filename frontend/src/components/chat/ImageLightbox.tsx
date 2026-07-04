import { ActionIcon, Modal } from "@mantine/core";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFileUrl } from "../../hooks/useFileUrl.ts";
import type { FileInfo } from "../../types/api.ts";
import { useAuth } from "../../useAuth.tsx";

interface Props {
	images: FileInfo[];
	startIndex: number;
	onClose: () => void;
}

export function ImageLightbox({ images, startIndex, onClose }: Props) {
	const [index, setIndex] = useState(startIndex);
	const { t } = useTranslation();
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
		<Modal
			opened={images.length > 0}
			onClose={onClose}
			fullScreen
			withCloseButton={false}
			styles={{
				content: {
					background: "rgba(0, 0, 0, 0.9)",
				},
				body: {
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					height: "100vh",
					padding: 0,
				},
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
					zIndex: 1,
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
						zIndex: 1,
					}}
				>
					<ChevronLeft size={32} />
				</ActionIcon>
			)}

			{loading ? (
				<ActionIcon variant="subtle" color="gray" size="xl" loading />
			) : error || !blobUrl ? (
				<p style={{ color: "white" }}>{t("media.loadImageFailed")}</p>
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
						zIndex: 1,
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
						zIndex: 1,
					}}
				>
					{index + 1} / {images.length}
				</div>
			)}
		</Modal>
	);
}
