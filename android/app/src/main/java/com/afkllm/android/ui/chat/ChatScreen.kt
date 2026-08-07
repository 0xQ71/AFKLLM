package com.afkllm.android.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.ViewSidebar
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.afkllm.android.MainViewModel
import com.afkllm.core.chat.ChatRole
import com.afkllm.core.i18n.StringKey
import com.afkllm.core.i18n.UiLanguage
import com.afkllm.core.i18n.t

@Composable
fun ChatScreen(
    vm: MainViewModel,
    lang: UiLanguage,
    sidePanelOpen: Boolean,
    onToggleSessions: () -> Unit
) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val settings by vm.settings.collectAsStateWithLifecycle()
    val session = vm.activeSession()
    val listState = rememberLazyListState()

    LaunchedEffect(session?.messages?.size, ui.streamingText) {
        val count = (session?.messages?.size ?: 0) + if (ui.streamingText.isNotEmpty()) 1 else 0
        if (count > 0) listState.animateScrollToItem(count - 1)
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .imePadding()
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = onToggleSessions) {
                Icon(
                    Icons.Outlined.ViewSidebar,
                    contentDescription = if (sidePanelOpen) t(lang, StringKey.SIDEBAR_COLLAPSE)
                    else t(lang, StringKey.SIDEBAR_SESSIONS)
                )
            }
            Text(
                session?.title ?: t(lang, StringKey.APP_NAME),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onBackground,
                modifier = Modifier.weight(1f)
            )
        }

        if (session == null || (session.messages.isEmpty() && ui.streamingText.isEmpty())) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text(
                    if (!ui.modelLoaded) t(lang, StringKey.CHAT_MODEL_NEEDED)
                    else t(lang, StringKey.CHAT_EMPTY),
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                items(session.messages, key = { it.id }) { msg ->
                    MessageBubble(role = msg.role, content = msg.content)
                }
                if (ui.streamingText.isNotEmpty()) {
                    item("stream") {
                        MessageBubble(role = ChatRole.ASSISTANT, content = ui.streamingText)
                    }
                }
            }
        }

        if (ui.error == "model") {
            Text(
                t(lang, StringKey.CHAT_MODEL_NEEDED),
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = 16.dp)
            )
        } else if (ui.error != null) {
            Text(
                ui.error ?: "",
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = 16.dp)
            )
        }

        Row(
            Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            FilterChip(
                selected = settings.agentAutoApprove,
                onClick = { vm.updateSettings { it.copy(agentAutoApprove = !it.agentAutoApprove) } },
                label = { Text(t(lang, StringKey.CHAT_AUTO)) }
            )
            FilterChip(
                selected = settings.agentThinkThrough,
                onClick = { vm.updateSettings { it.copy(agentThinkThrough = !it.agentThinkThrough) } },
                label = { Text(t(lang, StringKey.CHAT_THINK)) }
            )
            FilterChip(
                selected = settings.agentPlanMode,
                onClick = { vm.updateSettings { it.copy(agentPlanMode = !it.agentPlanMode) } },
                label = { Text(t(lang, StringKey.CHAT_PLAN)) }
            )
            if (ui.generating) {
                Text(
                    t(lang, StringKey.CHAT_GENERATING),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.align(Alignment.CenterVertically)
                )
            }
        }

        Row(
            Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalAlignment = Alignment.Bottom
        ) {
            OutlinedTextField(
                value = ui.draft,
                onValueChange = vm::setDraft,
                modifier = Modifier.weight(1f),
                placeholder = { Text(t(lang, StringKey.CHAT_HINT)) },
                maxLines = 5
            )
            Spacer(Modifier.width(8.dp))
            if (ui.generating) {
                IconButton(onClick = vm::stop) {
                    Icon(Icons.Outlined.Stop, contentDescription = t(lang, StringKey.CHAT_STOP))
                }
            } else {
                IconButton(onClick = vm::send, enabled = ui.draft.isNotBlank()) {
                    Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = t(lang, StringKey.CHAT_SEND))
                }
            }
        }
    }
}

@Composable
private fun MessageBubble(role: ChatRole, content: String) {
    val mine = role == ChatRole.USER
    Column(
        Modifier.fillMaxWidth(),
        horizontalAlignment = if (mine) Alignment.End else Alignment.Start
    ) {
        Text(
            if (mine) "You" else "AFKLLM",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(2.dp))
        Text(
            content,
            modifier = Modifier
                .clip(RoundedCornerShape(12.dp))
                .background(
                    if (mine) MaterialTheme.colorScheme.primary.copy(alpha = 0.2f)
                    else MaterialTheme.colorScheme.surfaceVariant
                )
                .padding(12.dp),
            color = MaterialTheme.colorScheme.onSurface
        )
    }
}
