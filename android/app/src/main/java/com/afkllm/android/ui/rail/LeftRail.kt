package com.afkllm.android.ui.rail

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Article
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.afkllm.core.i18n.StringKey
import com.afkllm.core.i18n.UiLanguage
import com.afkllm.core.i18n.t
import com.afkllm.core.settings.WorkspaceId

private data class RailItem(val id: WorkspaceId, val icon: ImageVector, val label: StringKey)

@Composable
fun ActivityBar(
    lang: UiLanguage,
    active: WorkspaceId,
    onSelect: (WorkspaceId) -> Unit
) {
    val items = listOf(
        RailItem(WorkspaceId.AGENT, Icons.AutoMirrored.Outlined.Chat, StringKey.WS_AGENT),
        RailItem(WorkspaceId.EXPLORER, Icons.Outlined.FolderOpen, StringKey.WS_EXPLORER),
        RailItem(WorkspaceId.CODE, Icons.Outlined.Code, StringKey.WS_CODE),
        RailItem(WorkspaceId.TERMINAL, Icons.Outlined.Terminal, StringKey.WS_TERMINAL),
        RailItem(WorkspaceId.BROWSER, Icons.Outlined.Language, StringKey.WS_BROWSER),
        RailItem(WorkspaceId.GIT, Icons.Outlined.AccountTree, StringKey.WS_GIT),
        RailItem(WorkspaceId.CONSOLE, Icons.AutoMirrored.Outlined.Article, StringKey.WS_CONSOLE)
    )
    Column(
        Modifier
            .width(48.dp)
            .fillMaxHeight()
            .background(MaterialTheme.colorScheme.surface)
            .verticalScroll(rememberScrollState())
            .padding(vertical = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp)
    ) {
        items.forEach { item ->
            RailIcon(
                icon = item.icon,
                selected = active == item.id,
                contentDescription = t(lang, item.label),
                onClick = { onSelect(item.id) }
            )
        }
        Spacer(Modifier.height(12.dp))
        RailIcon(
            icon = Icons.Outlined.Settings,
            selected = active == WorkspaceId.SETTINGS,
            contentDescription = t(lang, StringKey.RAIL_SETTINGS),
            onClick = { onSelect(WorkspaceId.SETTINGS) }
        )
    }
}

@Composable
private fun RailIcon(
    icon: ImageVector,
    selected: Boolean,
    contentDescription: String,
    onClick: () -> Unit
) {
    Box(
        Modifier
            .size(40.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(
                if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.2f)
                else MaterialTheme.colorScheme.surface
            )
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        Icon(
            icon,
            contentDescription = contentDescription,
            tint = if (selected) MaterialTheme.colorScheme.primary
            else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(20.dp)
        )
    }
}
