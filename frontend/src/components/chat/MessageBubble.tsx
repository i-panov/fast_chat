import {
	ActionIcon,
	Anchor,
	Button,
	Group,
	Paper,
	Stack,
	Text,
	UnstyledButton,
} from "@mantine/core";
import { Check, Copy, MessageCircle, Pencil, Trash2 } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { extractCodeText } from "../../utils/chat.ts";

interface CodeBlockProps {
	className?: string;
	code: string;
	lang: string;
}

function CodeBlock({ className, code, lang }: CodeBlockProps) {
	const [copied, setCopied] = useState(false);

	return (
		<div
			style={{
				maxHeight: "300px",
				overflow: "auto",
				background: "var(--mantine-color-dark-7)",
				borderRadius: "4px",
				marginTop: "4px",
				marginBottom: "2px",
			}}
		>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					position: "sticky",
					top: 0,
					background: "var(--mantine-color-dark-6)",
					padding: "2px 8px",
					borderBottom: "1px solid var(--mantine-color-dark-4)",
					zIndex: 1,
				}}
			>
				{lang ? (
					<Text size="xs" c="gray.6">
						{lang}
					</Text>
				) : (
					<div />
				)}
				<ActionIcon
					variant="subtle"
					color="gray"
					size="sm"
					onClick={() => {
						navigator.clipboard.writeText(code).then(() => {
							setCopied(true);
							setTimeout(() => setCopied(false), 2000);
						});
					}}
				>
					{copied ? <Check size={14} /> : <Copy size={14} />}
				</ActionIcon>
			</div>
			<pre style={{ padding: "8px", margin: 0 }}>
				<code className={className}>{code}</code>
			</pre>
		</div>
	);
}

interface Props {
	text: string;
	isOwn: boolean;
	time: string;
	chatId: string;
	msgId: string;
	editedAt?: string;
	onStartEdit: (chatId: string, messageId: string, text: string) => void;
	onDelete: (chatId: string, messageId: string) => void;
	editTTL: number;
	deleteTTL: number;
	createdAt: string;
	onCreateThread?: (chatId: string, messageId: string) => void;
	onOpenThread?: (threadId: string) => void;
	threadId?: string;
	threadMessageCount?: number;
	isInThread?: boolean;
}

function isWithinTTL(createdAt: string, ttl: number): boolean {
	if (ttl === 0) return true;
	if (ttl < 0) return false;
	return (Date.now() - new Date(createdAt).getTime()) / 1000 <= ttl;
}

export function MessageBubble({
	text,
	isOwn,
	time,
	chatId,
	msgId,
	editedAt,
	onStartEdit,
	onDelete,
	editTTL,
	deleteTTL,
	createdAt,
	onCreateThread,
	onOpenThread,
	threadId,
	threadMessageCount,
	isInThread,
}: Props) {
	const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const { t } = useTranslation();

	const canEdit = isOwn && isWithinTTL(createdAt, editTTL);
	const canDelete = isOwn && isWithinTTL(createdAt, deleteTTL);
	const canCreateThread =
		onCreateThread !== undefined && threadId === undefined && !isInThread;

	useLayoutEffect(() => {
		if (!menuPos || !menuRef.current) return;

		const el = menuRef.current;
		const rect = el.getBoundingClientRect();
		if (rect.right > window.innerWidth) {
			el.style.left = `${window.innerWidth - rect.width - 8}px`;
		}
		if (rect.bottom > window.innerHeight) {
			el.style.top = `${window.innerHeight - rect.height - 8}px`;
		}
	}, [menuPos]);

	const editedLabel =
		editedAt !== undefined
			? `${t("message.edited")} ${new Date(editedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`
			: null;

	return (
		<>
			<Paper
				style={{
					maxWidth: "70%",
					background: isOwn
						? "var(--mantine-color-blue-8)"
						: "var(--mantine-color-dark-6)",
					alignSelf: isOwn ? "flex-end" : "flex-start",
					padding: "8px 12px",
				}}
				onContextMenu={(e) => {
					e.preventDefault();
					setMenuPos({ x: e.clientX, y: e.clientY });
				}}
			>
				<Group gap={6} wrap="nowrap" align="end">
					<div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
						<Markdown
							remarkPlugins={[remarkGfm]}
							components={{
								p: ({ children }) => <span>{children}</span>,
								a: ({ href, children }) => (
									<Anchor href={href} target="_blank" rel="noreferrer">
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
												borderRadius: "3px",
												fontSize: "0.85em",
											}}
										>
											{children}
										</code>
									);
								},
								pre: ({ children }) => {
									const codeEl = children as {
										props: {
											className?: string;
											children: unknown;
										};
									};
									const className = codeEl.props.className ?? "";
									const lang = className.replace("language-", "");
									const codeText = extractCodeText(codeEl.props.children);
									return (
										<CodeBlock
											className={className}
											code={codeText}
											lang={lang}
										/>
									);
								},
							}}
						>
							{text}
						</Markdown>
					</div>
					<Text size="xs" c="gray.5" style={{ flexShrink: 0 }}>
						{editedLabel ?? time}
					</Text>
				</Group>
			</Paper>
			{threadId !== undefined && onOpenThread !== undefined && (
				<Button
					variant="subtle"
					color="gray"
					size="compact-xs"
					style={{
						alignSelf: isOwn ? "flex-end" : "flex-start",
						marginTop: 2,
					}}
					onClick={() => onOpenThread(threadId)}
				>
					<MessageCircle size={14} />
					{threadMessageCount !== undefined && threadMessageCount > 0 && (
						<Text component="span" size="xs" ml={2}>
							{threadMessageCount}
						</Text>
					)}
				</Button>
			)}
			{menuPos && (
				<>
					<UnstyledButton
						style={{
							position: "fixed",
							inset: 0,
							zIndex: 999,
							cursor: "default",
						}}
						onClick={() => setMenuPos(null)}
						aria-label="Close menu"
					/>
					<Paper
						ref={menuRef}
						style={{
							position: "fixed",
							left: menuPos.x,
							top: menuPos.y,
							zIndex: 1000,
							minWidth: "140px",
						}}
					>
						<Stack gap={0}>
							<Button
								variant="subtle"
								color="gray"
								fullWidth
								justify="flex-start"
								style={{ borderRadius: 0 }}
								onClick={() => {
									navigator.clipboard.writeText(text);
									setMenuPos(null);
								}}
							>
								<ActionIcon variant="transparent" color="gray" size={18} mr={6}>
									<Copy size={14} />
								</ActionIcon>
								{t("message.copy")}
							</Button>
							{canEdit && (
								<Button
									variant="subtle"
									color="gray"
									fullWidth
									justify="flex-start"
									style={{ borderRadius: 0 }}
									onClick={() => {
										onStartEdit(chatId, msgId, text);
										setMenuPos(null);
									}}
								>
									<ActionIcon
										variant="transparent"
										color="gray"
										size={18}
										mr={6}
									>
										<Pencil size={14} />
									</ActionIcon>
									{t("message.edit")}
								</Button>
							)}
							{canCreateThread && (
								<Button
									variant="subtle"
									color="gray"
									fullWidth
									justify="flex-start"
									style={{ borderRadius: 0 }}
									onClick={() => {
										onCreateThread?.(chatId, msgId);
										setMenuPos(null);
									}}
								>
									<ActionIcon
										variant="transparent"
										color="gray"
										size={18}
										mr={6}
									>
										<MessageCircle size={14} />
									</ActionIcon>
									{t("message.createThread")}
								</Button>
							)}
							{canDelete && (
								<Button
									variant="subtle"
									color="red"
									fullWidth
									justify="flex-start"
									style={{ borderRadius: 0 }}
									onClick={() => {
										onDelete(chatId, msgId);
										setMenuPos(null);
									}}
								>
									<ActionIcon
										variant="transparent"
										color="red"
										size={18}
										mr={6}
									>
										<Trash2 size={14} />
									</ActionIcon>
									{t("message.delete")}
								</Button>
							)}
						</Stack>
					</Paper>
				</>
			)}
		</>
	);
}
