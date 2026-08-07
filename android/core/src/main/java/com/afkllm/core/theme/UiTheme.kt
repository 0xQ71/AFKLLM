package com.afkllm.core.theme

/** Mirrors desktop `UiTheme` in src/shared/theme.ts */
enum class UiTheme(val id: String) {
    AUTO("auto"),
    CLASSIC("classic"),
    LIGHT("light"),
    SEPIA("sepia"),
    DARK("dark"),
    DEEP_DARK("deep-dark"),
    SOLARIZED_DARK("solarized-dark");

    companion object {
        val ALL = entries
        fun fromId(id: String?): UiTheme =
            entries.find { it.id == id } ?: CLASSIC
    }
}

enum class ResolvedUiTheme(val id: String) {
    CLASSIC("classic"),
    LIGHT("light"),
    SEPIA("sepia"),
    DARK("dark"),
    DEEP_DARK("deep-dark"),
    SOLARIZED_DARK("solarized-dark");

    companion object {
        fun fromId(id: String): ResolvedUiTheme =
            entries.find { it.id == id } ?: CLASSIC
    }
}

fun resolveUiTheme(theme: UiTheme, systemLight: Boolean): ResolvedUiTheme {
    if (theme != UiTheme.AUTO) {
        return ResolvedUiTheme.fromId(theme.id)
    }
    return if (systemLight) ResolvedUiTheme.LIGHT else ResolvedUiTheme.CLASSIC
}

data class AfkColors(
    val bg: Long,
    val bgElevated: Long,
    val bgHover: Long,
    val line: Long,
    val mute: Long,
    val soft: Long,
    val bright: Long,
    val signal: Long,
    val signalDim: Long,
    val onSignal: Long,
    val danger: Long,
    val warn: Long
)

fun colorsFor(theme: ResolvedUiTheme): AfkColors = when (theme) {
    ResolvedUiTheme.CLASSIC -> AfkColors(
        bg = 0xFF181818, bgElevated = 0xFF1F1F1F, bgHover = 0xFF2B2B2B,
        line = 0xFF2B2B2B, mute = 0xFF6E6E6E, soft = 0xFF9D9D9D, bright = 0xFFCCCCCC,
        signal = 0xFF3794FF, signalDim = 0xFF2B6CB0, onSignal = 0xFFFFFFFF,
        danger = 0xFFF48771, warn = 0xFFCCA700
    )
    ResolvedUiTheme.DARK -> AfkColors(
        bg = 0xFF1E1E1E, bgElevated = 0xFF252526, bgHover = 0xFF2A2D2E,
        line = 0xFF3C3C3C, mute = 0xFF858585, soft = 0xFFB0B0B0, bright = 0xFFD4D4D4,
        signal = 0xFF3794FF, signalDim = 0xFF2B6CB0, onSignal = 0xFFFFFFFF,
        danger = 0xFFF48771, warn = 0xFFCCA700
    )
    ResolvedUiTheme.LIGHT -> AfkColors(
        bg = 0xFFF3F3F3, bgElevated = 0xFFFFFFFF, bgHover = 0xFFE8E8E8,
        line = 0xFFE5E5E5, mute = 0xFF8B8B8B, soft = 0xFF616161, bright = 0xFF1E1E1E,
        signal = 0xFF005FB8, signalDim = 0xFF004578, onSignal = 0xFFFFFFFF,
        danger = 0xFFC72E0F, warn = 0xFF9A6700
    )
    ResolvedUiTheme.SEPIA -> AfkColors(
        bg = 0xFFF4ECD8, bgElevated = 0xFFFAF6EB, bgHover = 0xFFE8DCC4,
        line = 0xFFD4C4A8, mute = 0xFF9A856C, soft = 0xFF7A654E, bright = 0xFF5B4636,
        signal = 0xFF8B5A2B, signalDim = 0xFF6B4423, onSignal = 0xFFFAF6EB,
        danger = 0xFFA33B2B, warn = 0xFF8A6A20
    )
    ResolvedUiTheme.DEEP_DARK -> AfkColors(
        bg = 0xFF000000, bgElevated = 0xFF0A0A0A, bgHover = 0xFF1A1A1A,
        line = 0xFF222222, mute = 0xFF6E6E6E, soft = 0xFFA0A0A0, bright = 0xFFE4E4E4,
        signal = 0xFF3794FF, signalDim = 0xFF2B6CB0, onSignal = 0xFFFFFFFF,
        danger = 0xFFF48771, warn = 0xFFCCA700
    )
    ResolvedUiTheme.SOLARIZED_DARK -> AfkColors(
        bg = 0xFF002B36, bgElevated = 0xFF073642, bgHover = 0xFF0A4A58,
        line = 0xFF586E75, mute = 0xFF657B83, soft = 0xFF839496, bright = 0xFF93A1A1,
        signal = 0xFF268BD2, signalDim = 0xFF1A6FA0, onSignal = 0xFFFDF6E3,
        danger = 0xFFDC322F, warn = 0xFFB58900
    )
}
