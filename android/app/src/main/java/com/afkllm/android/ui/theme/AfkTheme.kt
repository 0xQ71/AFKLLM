package com.afkllm.android.ui.theme


import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import com.afkllm.core.theme.AfkColors
import com.afkllm.core.theme.ResolvedUiTheme
import com.afkllm.core.theme.colorsFor

val LocalAfkColors = staticCompositionLocalOf { colorsFor(ResolvedUiTheme.CLASSIC) }

@Composable
fun AfkTheme(theme: ResolvedUiTheme, content: @Composable () -> Unit) {
    val c = colorsFor(theme)
    val lightLike = theme == ResolvedUiTheme.LIGHT || theme == ResolvedUiTheme.SEPIA
    val scheme = if (lightLike) {
        lightColorScheme(
            primary = Color(c.signal),
            onPrimary = Color(c.onSignal),
            secondary = Color(c.signalDim),
            background = Color(c.bg),
            onBackground = Color(c.bright),
            surface = Color(c.bgElevated),
            onSurface = Color(c.bright),
            surfaceVariant = Color(c.bgHover),
            onSurfaceVariant = Color(c.soft),
            outline = Color(c.line),
            error = Color(c.danger)
        )
    } else {
        darkColorScheme(
            primary = Color(c.signal),
            onPrimary = Color(c.onSignal),
            secondary = Color(c.signalDim),
            background = Color(c.bg),
            onBackground = Color(c.bright),
            surface = Color(c.bgElevated),
            onSurface = Color(c.bright),
            surfaceVariant = Color(c.bgHover),
            onSurfaceVariant = Color(c.soft),
            outline = Color(c.line),
            error = Color(c.danger)
        )
    }
    CompositionLocalProvider(LocalAfkColors provides c) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}

@Composable
fun afkColors(): AfkColors = LocalAfkColors.current
