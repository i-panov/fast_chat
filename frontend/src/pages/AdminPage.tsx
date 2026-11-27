import { Alert, Button, Container, Group, Tabs, Title } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AdminChat } from "../api.ts";
import { AuditTab } from "../components/admin/AuditTab.tsx";
import { BotsTab } from "../components/admin/BotsTab.tsx";
import { ChatsTab } from "../components/admin/ChatsTab.tsx";
import { FederationTab } from "../components/admin/FederationTab.tsx";
import { MessagesTab } from "../components/admin/MessagesTab.tsx";
import {
	ConfirmDialog,
	type ConfirmState,
} from "../components/admin/shared.tsx";
import { UsersTab } from "../components/admin/UsersTab.tsx";
import { useAuth } from "../useAuth.tsx";

export function AdminPage() {
	const { t } = useTranslation();
	const { activeAccount } = useAuth();
	const navigate = useNavigate();
	const [tab, setTab] = useState<string | null>("users");
	const [selectedChat, setSelectedChat] = useState<AdminChat | null>(null);
	const [confirm, setConfirm] = useState<ConfirmState | null>(null);

	const backToChats = () => {
		// Router navigation keeps the chat page state and the unlocked local
		// keys; a plain <a href> would reload the whole SPA.
		void navigate({
			to: "/chat",
			search: { chatId: undefined, threadId: undefined },
		});
	};

	if (activeAccount === null) {
		return (
			<Container size="sm" py="xl">
				<Alert color="red">{t("admin.forbidden")}</Alert>
			</Container>
		);
	}

	if (activeAccount.user.isAdmin !== true) {
		return (
			<Container size="sm" py="xl">
				<Alert color="orange" title={t("admin.forbidden")}>
					<Button onClick={backToChats} variant="light" mt="sm">
						{t("admin.back")}
					</Button>
				</Alert>
			</Container>
		);
	}

	const token = activeAccount.token;

	return (
		<Container size="xl" py="md">
			<Group justify="space-between" mb="md">
				<Title order={2}>{t("admin.title")}</Title>
				<Button onClick={backToChats} variant="default">
					{t("admin.back")}
				</Button>
			</Group>

			<Tabs value={tab} onChange={setTab} keepMounted={false}>
				<Tabs.List>
					<Tabs.Tab value="users">{t("admin.users")}</Tabs.Tab>
					<Tabs.Tab value="chats">{t("admin.chats")}</Tabs.Tab>
					<Tabs.Tab value="messages">{t("admin.messages")}</Tabs.Tab>
					<Tabs.Tab value="bots">{t("admin.bots")}</Tabs.Tab>
					<Tabs.Tab value="federation">{t("admin.federation")}</Tabs.Tab>
					<Tabs.Tab value="audit">{t("admin.audit")}</Tabs.Tab>
				</Tabs.List>

				<Tabs.Panel value="users" pt="md">
					<UsersTab
						token={token}
						selfID={activeAccount.user.id}
						ask={setConfirm}
						t={t}
					/>
				</Tabs.Panel>
				<Tabs.Panel value="chats" pt="md">
					<ChatsTab
						token={token}
						ask={setConfirm}
						onMessages={(chat) => {
							setSelectedChat(chat);
							setTab("messages");
						}}
						t={t}
					/>
				</Tabs.Panel>
				<Tabs.Panel value="messages" pt="md">
					<MessagesTab
						token={token}
						chat={selectedChat}
						ask={setConfirm}
						t={t}
					/>
				</Tabs.Panel>
				<Tabs.Panel value="bots" pt="md">
					<BotsTab token={token} t={t} />
				</Tabs.Panel>
				<Tabs.Panel value="federation" pt="md">
					<FederationTab token={token} t={t} />
				</Tabs.Panel>
				<Tabs.Panel value="audit" pt="md">
					<AuditTab token={token} t={t} />
				</Tabs.Panel>
			</Tabs>

			<ConfirmDialog state={confirm} onClose={() => setConfirm(null)} t={t} />
		</Container>
	);
}
