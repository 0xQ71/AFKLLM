package com.afkllm.android.ui.rail

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ChevronLeft
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.afkllm.core.chat.ChatSession
import com.afkllm.core.i18n.StringKey
import com.afkllm.core.i18n.UiLanguage
import com.afkllm.core.i18n.t

@Composable
fun SessionsSidebar(
    lang: UiLanguage,
    sessions: List<ChatSession>,
    activeId: String?,
    width: Dp = 120.dp,
    onSelect: (String) -> Unit,
    onNew: () -> Unit,
    onCollapse: () -> Unit
) {
    Column(
        Modifier
            .width(width)
            .fillMaxHeight()
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f))
            .padding(4.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onCollapse, modifier = Modifier.size(32.dp)) {
                Icon(
                    Icons.Outlined.ChevronLeft,
                    contentDescription = t(lang, StringKey.SIDEBAR_COLLAPSE),
                    modifier = Modifier.size(18.dp)
                )
            }
            Text(
                t(lang, StringKey.SIDEBAR_SESSIONS),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
            IconButton(onClick = onNew, modifier = Modifier.size(32.dp)) {
                Icon(
                    Icons.Outlined.Add,
                    contentDescription = t(lang, StringKey.RAIL_NEW_CHAT),
                    modifier = Modifier.size(18.dp)
                )
            }
        }
        Spacer(Modifier.height(2.dp))
        LazyColumn(Modifier.weight(1f)) {
            items(sessions, key = { it.id }) { session ->
                val selected = session.id == activeId
                Text(
                    session.title.ifBlank { t(lang, StringKey.CHAT_EMPTY) },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 1.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(
                            if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)
                            else MaterialTheme.colorScheme.surface.copy(alpha = 0f)
                        )
                        .clickable { onSelect(session.id) }
                        .padding(horizontal = 8.dp, vertical = 8.dp),
                    color = MaterialTheme.colorScheme.onSurface
                )
            }
        }
    }
}
