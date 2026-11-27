import { Button, Container, Stack, Text, Title } from "@mantine/core";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, type ReactNode } from "react";
import i18n from "../i18n.ts";

export interface ErrorDiagnostic {
	// Deliberately no message: an exception text can contain chat names,
	// user ids or message fragments. Component stack is structural only.
	name: string;
	componentStack: string;
}

interface Props {
	children: ReactNode;
	fallback?: ReactNode;
	// Self-hosted operators can forward diagnostics to their own collector.
	onError?: (diagnostic: ErrorDiagnostic) => void;
}

interface State {
	error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
	override state: State = { error: null };
	private unsubscribeNavigation: (() => void) | undefined;
	private disposed = false;

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	override componentDidCatch(error: Error, info: React.ErrorInfo) {
		const diagnostic: ErrorDiagnostic = {
			name: error.name,
			componentStack: info.componentStack ?? "",
		};
		console.error("ErrorBoundary caught:", diagnostic);
		this.props.onError?.(diagnostic);
		this.watchNavigation();
	}

	// A boundary that stays failed across a route change hides the new page
	// behind the old fallback. Subscribe to router navigation only while an
	// error is shown, so the healthy path does not pull in the router.
	private watchNavigation() {
		if (this.unsubscribeNavigation !== undefined) return;
		void import("../router.tsx")
			.then(({ getRouter }) => {
				if (this.disposed || this.state.error === null) return;
				let lastPath = window.location.pathname;
				this.unsubscribeNavigation = getRouter().history.subscribe(
					({ location }) => {
						if (location.pathname === lastPath) return;
						lastPath = location.pathname;
						this.reset();
					},
				);
			})
			.catch(() => {
				// Without a router the fallback still offers a full reload.
			});
	}

	override componentDidMount() {
		if (typeof i18n.on === "function") {
			i18n.on("languageChanged", this.handleLanguage);
		}
	}

	override componentWillUnmount() {
		this.disposed = true;
		this.unsubscribeNavigation?.();
		this.unsubscribeNavigation = undefined;
		const off = (i18n as unknown as { off?: unknown }).off;
		if (typeof off === "function") {
			(off as (event: string, cb: () => void) => void).call(
				i18n,
				"languageChanged",
				this.handleLanguage,
			);
		}
	}

	private handleLanguage = () => {
		// Re-render translated fallback strings on language switch.
		this.forceUpdate();
	};

	reset = () => {
		this.unsubscribeNavigation?.();
		this.unsubscribeNavigation = undefined;
		this.setState({ error: null });
	};

	override render() {
		const { error } = this.state;
		const { children, fallback } = this.props;

		if (error === null) return children;

		if (fallback !== undefined) return fallback;

		return (
			<Container
				size="sm"
				py="xl"
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					minHeight: "100vh",
				}}
			>
				<Stack align="center" gap="md">
					<AlertTriangle size={48} color="var(--mantine-color-orange-5)" />
					<Title order={2} ta="center">
						{i18n.t("error.boundaryTitle")}
					</Title>
					<Text c="dimmed" ta="center">
						{i18n.t("error.boundaryMessage")}
					</Text>
					<Button leftSection={<RotateCcw size={16} />} onClick={this.reset}>
						{i18n.t("error.boundaryReset")}
					</Button>
					<Button component="a" href="/chat" variant="subtle">
						{i18n.t("error.boundaryBack")}
					</Button>
				</Stack>
			</Container>
		);
	}
}
