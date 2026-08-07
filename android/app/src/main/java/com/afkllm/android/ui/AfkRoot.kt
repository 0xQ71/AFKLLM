package com.afkllm.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.afkllm.android.MainViewModel
import com.afkllm.android.ui.chat.ChatScreen
import com.afkllm.android.ui.rail.ActivityBar
import com.afkllm.android.ui.rail.SessionsSidebar
import com.afkllm.android.ui.settings.SettingsScreen
import com.afkllm.android.ui.store.ModelStoreScreen
import com.afkllm.android.ui.workspace.BrowserScreen
import com.afkllm.android.ui.workspace.CodeScreen
import com.afkllm.android.ui.workspace.ConsoleScreen
import com.afkllm.android.ui.workspace.ExplorerScreen
import com.afkllm.android.ui.workspace.GitScreen
import com.afkllm.android.ui.workspace.TerminalScreen
import com.afkllm.core.settings.WorkspaceId

@Composable
fun AfkRoot(vm: MainViewModel) {
    val settings by vm.settings.collectAsStateWithLifecycle()
    val ui by vm.ui.collectAsStateWithLifecycle()
    val lang = settings.uiLanguage

    Box(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .windowInsetsPadding(WindowInsets.systemBars)
    ) {
        if (ui.showModelStore) {
            ModelStoreScreen(vm = vm, lang = lang)
            return
        }

        BoxWithConstraints(Modifier.fillMaxSize()) {
            val narrow = maxWidth < 600.dp
            val sidebarWidth = if (narrow) 120.dp else 148.dp

            Row(Modifier.fillMaxSize()) {
                ActivityBar(
                    lang = lang,
                    active = ui.workspace,
                    onSelect = vm::setWorkspace
                )

                when (ui.workspace) {
                    WorkspaceId.SETTINGS -> {
                        SettingsScreen(vm = vm, lang = lang, embedded = true)
                    }
                    else -> {
                        if (ui.workspace == WorkspaceId.AGENT && ui.sidePanelOpen) {
                            SessionsSidebar(
                                lang = lang,
                                sessions = ui.sessions,
                                activeId = ui.activeSessionId,
                                width = sidebarWidth,
                                onSelect = { id ->
                                    vm.selectSession(id)
                                    if (narrow) vm.setSidePanelOpen(false)
                                },
                                onNew = {
                                    vm.newChat()
                                    if (narrow) vm.setSidePanelOpen(false)
                                },
                                onCollapse = { vm.setSidePanelOpen(false) }
                            )
                        }
                        Box(
                            Modifier
                                .weight(1f)
                                .fillMaxHeight()
                                .fillMaxWidth()
                                .widthIn(min = 0.dp)
                        ) {
                            when (ui.workspace) {
                                WorkspaceId.AGENT -> ChatScreen(
                                    vm = vm,
                                    lang = lang,
                                    sidePanelOpen = ui.sidePanelOpen,
                                    onToggleSessions = vm::toggleSidePanel
                                )
                                WorkspaceId.EXPLORER -> ExplorerScreen(vm = vm, lang = lang)
                                WorkspaceId.CODE -> CodeScreen(vm = vm, lang = lang)
                                WorkspaceId.TERMINAL -> TerminalScreen(vm = vm, lang = lang)
                                WorkspaceId.BROWSER -> BrowserScreen(vm = vm, lang = lang)
                                WorkspaceId.GIT -> GitScreen(vm = vm, lang = lang)
                                WorkspaceId.CONSOLE -> ConsoleScreen(vm = vm, lang = lang)
                                WorkspaceId.SETTINGS -> {}
                            }
                        }
                    }
                }
            }
        }
    }
}
