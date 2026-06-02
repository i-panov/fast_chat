import { ActionIcon, Button, Paper, Text, Textarea } from "@mantine/core";
import { X } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";

interface Props {
	text: string;
	onTextChange: (value: string) => void;
	onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
	editing: boolean;
	onCancelEdit: () => void;
	replyToNick?: string;
	replyToText?: string;
	onCancelReply?: () => void;
	onTypingStart?: () => void;
	onTypingStop?: () => void;
}

export function InputBar({
	text,
	onTextChange,
	onSubmit,
	editing,
	onCancelEdit,
	replyToNick,
	replyToText,
	onCancelReply,
	onTypingStart,
	onTypingStop,
}: Props) {
	const { t } = useTranslation();

	return (
		<div>
			{replyToNick !== undefined && replyToText !== undefined && !editing && (
				<Paper
					style={{
						padding: "8px 12px",
						borderRadius: 0,
						borderTop: "1px solid var(--mantine-color-dark-4)",
						background: "var(--mantine-color-dark-7)",
					}}
				>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
						}}
					>
						<div style={{ flex: 1, overflow: "hidden" }}>
							<Text size="xs" c="blue" truncate="end">
								{t("input.replyingTo", { nick: replyToNick })}
							</Text>
							<Text size="xs" c="dimmed" truncate="end">
								{replyToText}
							</Text>
						</div>
						<ActionIcon
							variant="subtle"
							color="gray"
							size="sm"
							onClick={onCancelReply}
						>
							<X size={16} />
						</ActionIcon>
					</div>
				</Paper>
			)}
			{editing && (
				<Paper
					style={{
						padding: "8px 12px",
						borderRadius: 0,
						borderTop: "1px solid var(--mantine-color-dark-4)",
						background: "var(--mantine-color-dark-7)",
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
					}}
				>
					<Text size="sm" c="blue">
						{t("input.editBanner")}
					</Text>
					<ActionIcon
						variant="subtle"
						color="gray"
						size="sm"
						onClick={onCancelEdit}
					>
						<X size={16} />
					</ActionIcon>
				</Paper>
			)}
			<form
				style={{
					display: "flex",
					gap: "8px",
					padding: "12px",
					borderTop: editing
						? undefined
						: "1px solid var(--mantine-color-dark-4)",
					background: "var(--mantine-color-dark-8)",
				}}
				onSubmit={(e) => {
					onTypingStop?.();
					onSubmit(e);
				}}
			>
				<Textarea
					placeholder={t("input.placeholder")}
					value={text}
					onChange={(e) => {
						onTextChange(e.target.value);
						onTypingStart?.();
					}}
					style={{ flex: 1 }}
					size="sm"
					autosize
					minRows={1}
					maxRows={6}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							e.currentTarget.form?.requestSubmit();
						}
						if (e.key === "Escape" && editing) {
							onCancelEdit();
						}
					}}
				/>
				<Button type="submit" disabled={text.trim().length === 0} size="sm">
					{editing ? t("input.save") : t("input.send")}
				</Button>
			</form>
		</div>
	);
}
