package com.afkllm.android


import android.app.Application
import com.afkllm.core.chat.ChatRepository
import com.afkllm.core.settings.SettingsStore
import com.afkllm.llama.LlamaEngine
import com.afkllm.llama.createLlamaEngine

class AfkApp : Application() {
    lateinit var settingsStore: SettingsStore
        private set
    lateinit var chatRepository: ChatRepository
        private set
    lateinit var llamaEngine: LlamaEngine
        private set

    override fun onCreate() {
        super.onCreate()
        settingsStore = SettingsStore(this)
        chatRepository = ChatRepository(this)
        llamaEngine = createLlamaEngine()
    }
}
