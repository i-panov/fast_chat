import { Anchor, Group, Loader, Text } from "@mantine/core";
import { isValidElement } from "react";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MessageDeliveryStatus } from "../../../types/api.ts";
import { extractCodeText } from "../../../utils/chat.ts";
import { CodeBlock } from "../CodeBlock.tsx";
import { MessageStatus } from "./MessageStatus.tsx";

const BORDER_RADIUS_CODE = 3;

interface Props {
	text: string;
	status?: "sent" | "queued" | "failed";
	deliveryStatus?: MessageDeliveryStatus;
	isOwn?: boolean;
	time: string;
	editedAt?: string;
	locale: string;
}

export function MessageBody({
	text,
	status,
	deliveryStatus,
	isOwn,
	time,
	editedAt,
	locale,
}: Props) {
	const { t } = useTranslation();

	const editedLabel =
		editedAt !== undefined
			? `${t("message.edited")} ${new Date(editedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`
			: null;

	if (text.length === 0) return null;

	return (
		<Group gap={6} wrap="nowrap" align="end">
			<div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
				<Markdown
					remarkPlugins={[remarkGfm]}
					components={{
						p: ({ children }) => <span>{children}</span>,
						a: ({ href, children }) => (
							<Anchor href={href} target="_blank" rel="noopener noreferrer">
								{children}
							</Anchor>
						),
						code: ({ className, children }) => {
							const lang = className?.replace("language-", "");
							if (lang) {
								return <code className={className}>{children}</code>;
							}
							return (
								<code
									style={{
										background: "var(--mantine-color-dark-7)",
										padding: "1px 4px",
										borderRadius: BORDER_RADIUS_CODE,
										fontSize: "0.85em",
									}}
								>
									{children}
								</code>
							);
						},
						pre: ({ children }) => {
							if (!isValidElement(children)) {
								return <pre>{children}</pre>;
							}
							const codeEl = children as React.ReactElement<{
								className?: string;
								children: unknown;
							}>;
							const className = codeEl.props.className ?? "";
							const lang = className.replace("language-", "");
							const codeText = extractCodeText(codeEl.props.children);
							return (
								<CodeBlock className={className} code={codeText} lang={lang} />
							);
						},
					}}
				>
					{text}
				</Markdown>
			</div>
			<Text
				size="xs"
				c="gray.5"
				style={{
					flexShrink: 0,
					display: "flex",
					alignItems: "center",
					gap: 4,
				}}
			>
				{status === "queued" && (
					<Loader size={4} aria-label={t("message.queued")} />
				)}
				{status === "failed" && (
					<span
						style={{ color: "var(--mantine-color-red-5)" }}
						title={t("message.failed")}
					>
						!
					</span>
				)}
				{editedLabel ?? time}
				{isOwn === true && deliveryStatus !== undefined && (
					<MessageStatus status={deliveryStatus} />
				)}
			</Text>
		</Group>
	);
}
