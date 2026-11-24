import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useState } from "react";

export const PAGE_SIZE = 50;
export const COLUMN_NAME = "admin.name";
export const COLUMN_ACTIONS = "admin.actions";

export interface ConfirmState {
	title: string;
	body: string;
	onConfirm: () => Promise<void>;
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function useReload(): [number, () => void] {
	const [version, setVersion] = useState(0);
	const reload = useCallback(() => setVersion((value) => value + 1), []);

	return [version, reload];
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

	// biome-ignore lint/correctness/useExhaustiveDependencies: state is the reset trigger, not a value the effect reads.
	useEffect(() => {
		// The dialog stays mounted between actions: a failure from the
		// previous action must not be shown for the next one.
		setError(null);
	}, [state]);

	return (
		<Modal
			opened={state !== null}
			onClose={onClose}
			title={state?.title ?? ""}
			centered
		>
			<Stack gap="md">
				<Text size="sm">{state?.body}</Text>
				{error !== null && <Alert color="red">{error}</Alert>}
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						{t("admin.cancel")}
					</Button>
					<Button
						color="red"
						loading={busy}
						onClick={() => {
							if (state === null) return;
							setBusy(true);
							setError(null);
							void state
								.onConfirm()
								.then(() => {
									onClose();
								})
								.catch((err: unknown) => {
									setError(errorText(err));
								})
								.finally(() => setBusy(false));
						}}
					>
						{t("admin.confirm")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
