// Package textutil holds small, dependency-free text helpers shared by the
// store and service layers.
package textutil

import "unicode/utf8"

// TruncateUTF8 cuts value to at most limit bytes without splitting a UTF-8
// rune, so a truncated value is always valid text.
func TruncateUTF8(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if len(value) <= limit {
		return value
	}

	cut := limit
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}

	return value[:cut]
}
