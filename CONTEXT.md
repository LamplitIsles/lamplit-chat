# Lamplit

This glossary names the product and distinguishes a conversation, its working files, and the private material used to introduce an agent.

## Language

**Lamplit**:
The product's public name. It refers to the user-facing personal AI experience; `pi-on-cf` is only the repository's historical name.
_Avoid_: Pi on Cloudflare as the product name

**Personal deployment（个人部署）**:
One person's Lamplit instance in that person's Cloudflare account, preserving the chat agent experience when moving from hosting. The owner supplies the model credentials and controls the instance rather than relying on an always-on personal computer or VPS.
_Avoid_: Shared hosted account, local desktop installation

**Move-out（迁出）**:
The transfer of a user's hosted chat companion, its customization, history, memories, and settings into a personal deployment while preserving its chat experience. It includes the material needed to run independently of Lamplit's closed hosted services.
_Avoid_: Source-code clone, history export alone

**Hosted instance（托管实例）**:
One user's personal Lamplit experience operated by Lamplit on the user's behalf. The user directs its companion customization while Lamplit maintains the underlying service.
_Avoid_: Personal deployment, shared companion

**Personal build（自建）**:
The user's participation in shaping their own companion experience, including its personality, interface, memories, and connected capabilities. A personal build can run as either a hosted instance or a personal deployment.
_Avoid_: Self-hosting as a prerequisite, server administration

**Companion customization（陪伴定制）**:
The user's changes to their companion's interface, personality, memory preferences, and connected capabilities. It is distinct from the conversations and memories accumulated through use.
_Avoid_: Conversation history, learned memory

**Conversation archive（历史对话档案）**:
The user's preserved past conversations, including imported conversations, available for reading and search by the user and companion. An archive is distinct from the selected memories and the active conversation context.
_Avoid_: Companion memory, current model context

**Companion plugin（聊天机插件）**:
A supported feature extension of the chat agent that can add capabilities and their corresponding user-facing interactions. The user can configure its exposed parameters and prompts.
_Avoid_: Arbitrary backend fork, frontend theme, MCP connection alone

**Chat agent（聊天机）**:
A personal conversational AI with its own continuing identity and private context. Its instructions emphasize companionship and memory, while its available capabilities can include the same tools and execution abilities as the work agent.
_Avoid_: Read-only companion, chat mode

**Core web chat（核心网页聊天）**:
The owner's browser conversation with the chat agent, including durable conversation context. It does not require an optional messaging connector or the work agent's execution capabilities.
_Avoid_: Keet connection, work-agent task

**Chat agent engine（聊天机引擎）**:
The system that carries a chat agent's conversations and execution. The engine is distinct from the companion's continuing identity, personality, and memories.
_Avoid_: Companion identity, model provider, chat mode

**Work agent（工作机）**:
A platform-maintained task-focused AI with its own identity and work context, used to customize the user's chat companion rather than being a customization target itself. It does not have exclusive access to execution capabilities; information shared with the separate chat agent must be explicit.
_Avoid_: User-customized companion, sole executor, work mode

**Jiji（霁霁）**:
The continuing companion identity shared across sessions. Separate conversations do not create separate versions of Jiji.
_Avoid_: Session agent, session-specific persona

**Session（会话）**:
One conversation line with its own history and working files. A session is not itself an agent identity.
_Avoid_: Agent, identity

**Main session（主会话）**:
Jiji's continuing conversation line shared by direct web messages and admitted Keet messages. Message provenance stays visible within that line; it is one conversation, not another copy of Jiji.
_Avoid_: Keet agent, identity clone

**Conversation photo（对话照片）**:
An image the Human sends in web chat, kept with its originating message and available for Jiji to inspect as image input.
_Avoid_: Keet image, generated image

**Session album（会话相册）**:
The collection of conversation photos sent anywhere in the main session, including photos on branches outside the currently visible conversation path. It shows thumbnails first and opens the full photo on demand; its images remain available after a browser reload.
_Avoid_: Current branch images, browser draft gallery

**User time zone（用户时区）**:
The Human's most recently known IANA time zone, shared by web and Keet turns when Jiji interprets local time. It is not the Keet sender's time zone.
_Avoid_: Worker time zone, Keet sender time zone

**Turn time（回合时间）**:
The time native Pi durably admits input for Jiji to process. It can differ from when a Keet message originally arrived and does not change during that turn's later model requests.
_Avoid_: Keet message time, model request time

**Keet-sourced message（Keet 来源消息）**:
An external Keet message admitted into the main session with its sender and destination attributed. It is visible as a distinct source in the web timeline and is not a direct instruction from the Human.
_Avoid_: Human message, anonymous user bubble

**Keet feed checkpoint（Keet 事件检查点）**:
The highest KFA webhook sequence durably stored by the main session. KFA keeps each event in its own journal until the Worker returns a 2xx receipt; a sequence gap remains an operator error.
_Avoid_: Connector-local cursor, read receipt

**Session workspace（会话工作区）**:
The files belonging to one session that the agent can inspect or change during that conversation.
_Avoid_: Local project directory

**Identity draft（身份底稿）**:
The privately maintained source material that introduces an agent's identity, relationships, and starting perspective. It is distinct from conversation history and learned memory.
_Avoid_: Session transcript, learned memory

**Session identity copy（会话身份副本）**:
The version of the identity draft explicitly synchronized into one session. Different sessions may temporarily hold different versions while still referring to the same Jiji.
_Avoid_: Canonical identity draft, new agent identity

**Companion base prompt（陪伴基础提示词）**:
The shared behavioral guidance for Jiji across sessions, separate from her specific identity and relationships.
_Avoid_: Identity draft, session history

**History import（聊天记录迁入）**:
The transfer of conversations from another chat application into the user's private conversation archive. Importing history does not by itself transfer the companion's personality or establish its learned memories.
_Avoid_: Full companion migration, memory extraction

**Active conversation（当前对话）**:
The conversation in which the user and companion exchange new messages. Its selected context is distinct from the full historical archive.
_Avoid_: Entire history archive, companion identity

**Message submission（消息提交）**:
The durable acceptance of the Human's message for processing in the active conversation. A submitted message remains submitted even when the companion's reply fails or is stopped.
_Avoid_: Model consumption, reply completion

**Companion reply（聊天机回复）**:
The companion's response to a submitted message. Its completion, failure, or interruption is distinct from whether the Human's message was submitted.
_Avoid_: Message delivery receipt

**Recoverable draft（可恢复草稿）**:
The Human's text and photos retained for editing when their submission has failed or has been withdrawn before processing. Temporarily losing confirmation of submission does not by itself make a message a recoverable draft.
_Avoid_: Failed reply, disconnected message

**Web search（网络搜索）**:
The companion's ability to find public webpages relevant to a query through the user's selected search provider. Search results identify sources and may contain excerpts; they are distinct from reading a page's body.
_Avoid_: Webpage reading, conversation archive search

**Webpage reading（网页读取）**:
The companion's ability to obtain readable content from a specific public webpage address, including an address supplied by the user. It is distinct from discovering addresses through network search.
_Avoid_: Web search, browser operation, reading private account content

**Voice input（语音输入）**:
Fixed Beijing `qwen-audio-3.1-asr-flash-streaming`: actual16kHz PCM AudioWorklet → authenticated `/api/voice/stream` → final-only cursor draft. [Wire/limits/privacy/fixture ownership](docs/voice-input.md) is authoritative. Existing independent `VOICE_API_KEY`/hosted encrypted settings stay unchanged. Audio streams while speaking; cancellation closes processing but cannot undo billing. Both chat/platform merges wait for Owner joint gate.
Dictation that contributes editable text to the user's unsent chat draft, including further speech added to an existing draft. The user decides when to send the resulting message.
_Avoid_: Voice message, automatic message sending, voice call

**Active context usage（当前上下文用量）**:
The current native model context occupancy, derived from the active branch and fresh valid native observations. It excludes accumulated billing and other branches; unavailable usage remains nullable while known capacity is retained.
_Avoid_: Lifetime token totals, a guessed context window

**Quiet compaction（静默整理）**:
An explicit or automatic native continuity operation whose successful completion produces no chat marker or toast. Its preserved native records support continuation, while stale context usage retires until a fresh valid observation.
_Avoid_: A user chat message, replay on reconnect
