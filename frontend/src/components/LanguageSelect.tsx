import { Select } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	getLanguagePreference,
	type LanguagePreference,
	resolveLanguage,
	SUPPORTED_LANGS,
	setLanguagePreference,
} from "../i18n.ts";

interface Props {
	size?: "xs" | "sm" | "md";
	withLabel?: boolean;
}

function isPreference(value: string): value is LanguagePreference {
	return value === "system" || (SUPPORTED_LANGS as string[]).includes(value);
}

// LanguageSelect changes the interface language immediately. "System" follows
// the browser/OS language and stays selected until the user picks a concrete
// one.
export function LanguageSelect({ size = "xs", withLabel = true }: Props) {
	const { t } = useTranslation();
	const [preference, setPreference] = useState<LanguagePreference>(
		getLanguagePreference(),
	);

	return (
		<Select
			data={[
				{ value: "system", label: t("lang.system") },
				...SUPPORTED_LANGS.map((lang) => ({
					value: lang,
					label: t(`lang.${lang}`),
				})),
			]}
			value={preference}
			onChange={(value) => {
				if (value === null || !isPreference(value)) return;
				setPreference(value);
				void setLanguagePreference(value);
			}}
			label={withLabel ? t("lang.label") : undefined}
			description={
				preference === "system"
					? t(`lang.${resolveLanguage("system")}`)
					: undefined
			}
			aria-label={withLabel ? undefined : t("lang.label")}
			allowDeselect={false}
			size={size}
			comboboxProps={{ withinPortal: true }}
		/>
	);
}
