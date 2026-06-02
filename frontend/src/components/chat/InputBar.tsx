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
	onTypingStart?: () => void;
	onTypingStop?: () => void;
}

export function InputBar({
	text,
	onTextChange,
	onSubmit,
	editing,
	onCancelEdit,
	onTypingStart,
	onTypingStop,
}: Props) {
	const { t } = useTranslation();

	return (
		<div>
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
