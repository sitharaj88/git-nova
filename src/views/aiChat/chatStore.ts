import * as vscode from 'vscode';

export type ChatRole = 'user' | 'assistant' | 'tool';

export interface ChatRecord {
  role: ChatRole;
  content: string;
  /** Set on 'tool' records (the tool that ran) and assistant tool-call turns. */
  tool?: string;
  /** JSON-stringified args for tool records. */
  args?: string;
  /** Assistant records that were raw JSON tool calls — hidden from display. */
  kind?: 'toolCall';
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatRecord[];
}

export interface ChatSessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

const STORE_KEY = 'gitNova.aiChat.sessions';
const MAX_SESSIONS = 30;
const MAX_MESSAGES_PER_SESSION = 200;

/**
 * ChatStore — persistent chat history, scoped to the workspace (so every
 * repo/project keeps its own conversations across VS Code restarts).
 */
export class ChatStore {
  constructor(private readonly memento: vscode.Memento) {}

  list(): ChatSession[] {
    const sessions = this.memento.get<ChatSession[]>(STORE_KEY, []);
    return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  listMeta(): ChatSessionMeta[] {
    return this.list().map(s => ({
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      messageCount: s.messages.length,
    }));
  }

  get(id: string): ChatSession | undefined {
    return this.list().find(s => s.id === id);
  }

  create(): ChatSession {
    const session: ChatSession = {
      id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: 'New chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    void this.save(session);
    return session;
  }

  async save(session: ChatSession): Promise<void> {
    session.updatedAt = Date.now();
    if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
      session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION);
    }
    const rest = this.list().filter(s => s.id !== session.id);
    // Newest first, capped
    const all = [session, ...rest].slice(0, MAX_SESSIONS);
    await this.memento.update(STORE_KEY, all);
  }

  async delete(id: string): Promise<void> {
    await this.memento.update(
      STORE_KEY,
      this.list().filter(s => s.id !== id)
    );
  }
}
