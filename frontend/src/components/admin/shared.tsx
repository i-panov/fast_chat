import {
	Alert,
	Button,
	Group,
	Modal,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api.ts";

export const PAGE_SIZE = 50;
export const COLUMN_NAME = "admin.name";
export const COLUMN_ACTIONS = "admin.actions";

export interface ConfirmState {
	title: string;
	body: string;
	onConfirm: () => Promise<void>;
	confirmLabel?: string;
	// Enabling a bot or granting a role is not destructive: keep the
	// confirmation button neutral for those.
	danger?: boolean;
}

// Server messages are English and may leak request details; translate the
// statuses the admin can act on and fall back to a generic message.
export function errorKey(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.status === 403) return "admin.forbiddenAction";
		if (error.status === 404) return "admin.notFound";
	}

	return "admin.actionFailed";
}

export function useReload(): [number, () => void] {
	const [version, setVersion] = useState(0);
	const reload = useCallback(() => setVersion((value) => value + 1), []);

	return [version, reload];
}

export function AdminSearchForm({
	value,
	onChange,
	onSubmit,
	placeholder,
	t,
}: {
	value: string;
	onChange: (value: string) => void;
	onSubmit: () => void;
	placeholder: string;
	t: TFunction;
}) {
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				onSubmit();
			}}
		>
			<Group>
				<TextInput
					placeholder={placeholder}
					aria-label={placeholder}
					value={value}
					onChange={(event) => onChange(event.currentTarget.value)}
					style={{ flex: 1 }}
				/>
				<Button type="submit">{t("admin.search")}</Button>
			</Group>
		</form>
	);
}

export function AdminPagination({
	offset,
	total,
	onChange,
	t,
}: {
	offset: number;
	total: number;
	onChange: (offset: number) => void;
	t: TFunction;
}) {
	return (
		<Group justify="space-between">
			<Text size="xs" c="dimmed">
				{t("admin.total", { count: total })}
			</Text>
			<Group gap="xs">
				<Button
					size="xs"
					variant="default"
					disabled={offset === 0}
					onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}
				>
					{t("admin.prev")}
				</Button>
				<Button
					size="xs"
					variant="default"
					disabled={offset + PAGE_SIZE >= total}
					onClick={() => onChange(offset + PAGE_SIZE)}
				>
					{t("admin.next")}
				</Button>
			</Group>
		</Group>
	);
}

export function ConfirmDialog({
	state,
	onClose,
	t,
}: {
	state: ConfirmState | null;
	onClose: () => void;
	t: TFunction;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// A request that finishes after the dialog was reopened for another
	// action must not close the new dialog.
	const requestSeqRef = useRef(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: state is the reset trigger, not a value the effect reads.
	useEffect(() => {
		// The dialog stays mounted between actions: a failure from the
		// previous action must not be shown for the next one.
		setError(null);
		setBusy(false);
		requestSeqRef.current++;
	}, [state]);

	const close = () => {
		if (busy) return;
		onClose();
	};

	return (
		<Modal
			opened={state !== null}
			onClose={close}
			closeOnClickOutside={!busy}
			closeOnEscape={!busy}
			withCloseButton={!busy}
			title={state?.title ?? ""}
			centered
		>
			<Stack gap="md">
				<Text size="sm">{state?.body}</Text>
				{error !== null && <Alert color="red">{error}</Alert>}
				<Group justify="flex-end">
					<Button variant="default" onClick={close} disabled={busy}>
						{t("admin.cancel")}
					</Button>
					<Button
						color={state?.danger === false ? undefined : "red"}
						loading={busy}
						onClick={() => {
							if (state === null) return;
							const seq = ++requestSeqRef.current;
							setBusy(true);
							setError(null);
							void state
								.onConfirm()
								.then(() => {
									if (requestSeqRef.current === seq) onClose();
								})
								.catch((err: unknown) => {
									if (requestSeqRef.current === seq) {
										setError(t(errorKey(err)));
									}
								})
								.finally(() => {
									if (requestSeqRef.current === seq) setBusy(false);
								});
						}}
					>
						{state?.confirmLabel ?? t("admin.confirm")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
