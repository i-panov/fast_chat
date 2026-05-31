import {
	Button,
	Group,
	Overlay,
	ScrollArea,
	Stack,
	Text,
	TextInput,
	Title,
	UnstyledButton,
} from "@mantine/core";
import type { FormEvent } from "react";
import { useState } from "react";
import { useAuth } from "./useAuth.tsx";

interface Props {
	open: boolean;
	onClose: () => void;
}

function AccountRow({
	account,
	isActive,
	onClick,
}: {
	account: { token: string; user: { id: string; nick: string } };
	isActive: boolean;
	onClick: () => void;
}) {
	return (
		<UnstyledButton
			className={`flex items-center gap-3 w-full hover:bg-[var(--mantine-color-dark-6)] ${
				isActive ? "bg-[var(--mantine-color-dark-6)]" : ""
			}`}
			style={{
				padding: "12px 16px",
				borderBottom: "1px solid var(--mantine-color-dark-4)",
			}}
			onClick={onClick}
		>
			<Text
				span
				className="w-8 h-8 rounded-full bg-[var(--mantine-color-blue-8)] flex items-center justify-center text-white text-sm font-bold flex-shrink-0"
			>
				{(account.user.nick[0] ?? "").toUpperCase()}
			</Text>
			<Text span className="flex-1 text-sm text-white">
				@{account.user.nick}
			</Text>
			{isActive && (
				<Text span className="text-[var(--mantine-color-blue-5)] text-sm">
					✓
				</Text>
			)}
		</UnstyledButton>
	);
}

function AccountList({
	accounts,
	activeAccount,
	onSwitchAccount,
	onClose,
}: {
	accounts: { token: string; user: { id: string; nick: string } }[];
	activeAccount: { token: string; user: { id: string; nick: string } } | null;
	onSwitchAccount: (token: string) => void;
	onClose: () => void;
}) {
	return (
		<ScrollArea className="flex-1">
			{accounts.map((acc) => (
				<AccountRow
					key={acc.token}
					account={acc}
					isActive={acc.token === activeAccount?.token}
					onClick={() => {
						if (acc.token !== activeAccount?.token) {
							onSwitchAccount(acc.token);
							onClose();
						}
					}}
				/>
			))}
		</ScrollArea>
	);
}

function Footer({
	adding,
	error,
	loading,
	newNick,
	setNewNick,
	onSubmit,
	onCancel,
	onAddClick,
}: {
	adding: boolean;
	error: string;
	loading: boolean;
	newNick: string;
	setNewNick: (v: string) => void;
	onSubmit: (e: FormEvent<HTMLFormElement>) => void;
	onCancel: () => void;
	onAddClick: () => void;
}) {
	if (!adding) {
		return (
			<Button
				variant="outline"
				className="w-full border-dashed"
				onClick={onAddClick}
			>
				+ Add Account
			</Button>
		);
	}
	return (
		<form onSubmit={onSubmit}>
			<Stack gap="xs">
				<TextInput
					placeholder="Nickname"
					maxLength={20}
					value={newNick}
					onChange={(e) => setNewNick(e.target.value)}
				/>
				{error.length > 0 && (
					<Text size="sm" c="red">
						{error}
					</Text>
				)}
				<Group justify="flex-end" gap="xs">
					<Button
						type="submit"
						disabled={loading || newNick.trim().length === 0}
						loading={loading}
					>
						{loading ? "Adding..." : "Add"}
					</Button>
					<Button variant="default" onClick={onCancel}>
						Cancel
					</Button>
				</Group>
			</Stack>
		</form>
	);
}

interface HandleSubmitOpts {
	newNick: string;
	login: (nick: string) => Promise<void>;
	setAdding: (v: boolean) => void;
	setNewNick: (v: string) => void;
	setError: (v: string) => void;
	setLoading: (v: boolean) => void;
	onClose: () => void;
}

async function handleSubmit(
	e: FormEvent<HTMLFormElement>,
	opts: HandleSubmitOpts,
) {
	e.preventDefault();
	const trimmed = opts.newNick.trim();
	if (trimmed.length === 0) return;
	opts.setLoading(true);
	opts.setError("");
	try {
		await opts.login(trimmed);
		opts.setAdding(false);
		opts.setNewNick("");
		opts.onClose();
	} catch (err) {
		opts.setError(err instanceof Error ? err.message : "Registration failed");
	} finally {
		opts.setLoading(false);
	}
}

export function AccountSwitcher({ open, onClose }: Props) {
	const { accounts, activeAccount, switchAccount, login } = useAuth();
	const [adding, setAdding] = useState(false);
	const [newNick, setNewNick] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);

	return (
		<>
			{open && (
				<Overlay color="#000" opacity={0.5} zIndex={40} onClick={onClose} />
			)}
			<div
				className="fixed top-0 left-0 h-full w-[280px] bg-[var(--mantine-color-dark-8)] z-50 shadow-lg flex flex-col transition-transform duration-300 ease-in-out"
				style={{ transform: open ? "translateX(0)" : "translateX(-100%)" }}
			>
				<div className="px-4 py-4 border-b border-[var(--mantine-color-dark-4)]">
					<Title order={2} className="m-0 text-base text-white">
						Accounts
					</Title>
				</div>
				<AccountList
					accounts={accounts}
					activeAccount={activeAccount}
					onSwitchAccount={switchAccount}
					onClose={onClose}
				/>
				<div className="border-t border-[var(--mantine-color-dark-4)] p-4">
					<Footer
						adding={adding}
						error={error}
						loading={loading}
						newNick={newNick}
						setNewNick={setNewNick}
						onSubmit={(e) =>
							handleSubmit(e, {
								newNick,
								login,
								setAdding,
								setNewNick,
								setError,
								setLoading,
								onClose,
							})
						}
						onCancel={() => {
							setAdding(false);
							setError("");
						}}
						onAddClick={() => setAdding(true)}
					/>
				</div>
			</div>
		</>
	);
}
