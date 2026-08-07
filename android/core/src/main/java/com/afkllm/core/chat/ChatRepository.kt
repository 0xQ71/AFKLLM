package com.afkllm.core.chat

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

enum class ChatRole { USER, ASSISTANT, SYSTEM }

data class ChatMessage(
    val id: String = UUID.randomUUID().toString(),
    val role: ChatRole,
    val content: String,
    val createdAt: Long = System.currentTimeMillis()
)

data class ChatSession(
    val id: String = UUID.randomUUID().toString(),
    val title: String,
    val messages: List<ChatMessage> = emptyList(),
    val updatedAt: Long = System.currentTimeMillis()
)

class ChatRepository(context: Context) {
    private val dir = File(context.filesDir, "chats").also { it.mkdirs() }
    private val indexFile = File(dir, "index.json")

    suspend fun listSessions(): List<ChatSession> = withContext(Dispatchers.IO) {
        val ids = readIndex()
        ids.mapNotNull { loadSession(it) }.sortedByDescending { it.updatedAt }
    }

    suspend fun getSession(id: String): ChatSession? = withContext(Dispatchers.IO) {
        loadSession(id)
    }

    suspend fun createSession(title: String = "New chat"): ChatSession = withContext(Dispatchers.IO) {
        val session = ChatSession(title = title)
        saveSession(session)
        writeIndex(listOf(session.id) + readIndex().filter { it != session.id })
        session
    }

    suspend fun upsertSession(session: ChatSession): Unit = withContext(Dispatchers.IO) {
        saveSession(session.copy(updatedAt = System.currentTimeMillis()))
        val ids = readIndex().toMutableList()
        ids.remove(session.id)
        ids.add(0, session.id)
        writeIndex(ids)
    }

    suspend fun deleteSession(id: String): Unit = withContext(Dispatchers.IO) {
        File(dir, "$id.json").delete()
        writeIndex(readIndex().filter { it != id })
    }

    private fun readIndex(): List<String> {
        if (!indexFile.exists()) return emptyList()
        return try {
            val arr = JSONArray(indexFile.readText())
            (0 until arr.length()).map { arr.getString(it) }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun writeIndex(ids: List<String>) {
        val arr = JSONArray()
        ids.forEach { arr.put(it) }
        indexFile.writeText(arr.toString())
    }

    private fun loadSession(id: String): ChatSession? {
        val f = File(dir, "$id.json")
        if (!f.exists()) return null
        return try {
            val o = JSONObject(f.readText())
            val msgs = o.getJSONArray("messages")
            val list = (0 until msgs.length()).map { i ->
                val m = msgs.getJSONObject(i)
                ChatMessage(
                    id = m.getString("id"),
                    role = ChatRole.valueOf(m.getString("role")),
                    content = m.getString("content"),
                    createdAt = m.optLong("createdAt", 0L)
                )
            }
            ChatSession(
                id = o.getString("id"),
                title = o.getString("title"),
                messages = list,
                updatedAt = o.optLong("updatedAt", 0L)
            )
        } catch (_: Exception) {
            null
        }
    }

    private fun saveSession(session: ChatSession) {
        val msgs = JSONArray()
        session.messages.forEach { m ->
            msgs.put(
                JSONObject()
                    .put("id", m.id)
                    .put("role", m.role.name)
                    .put("content", m.content)
                    .put("createdAt", m.createdAt)
            )
        }
        val o = JSONObject()
            .put("id", session.id)
            .put("title", session.title)
            .put("updatedAt", session.updatedAt)
            .put("messages", msgs)
        File(dir, "${session.id}.json").writeText(o.toString())
    }
}
