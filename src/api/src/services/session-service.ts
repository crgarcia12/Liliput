export interface Session {
  sessionId: string;
  createdAt: string;
  messages: Message[];
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface SessionService {
  createSession(): Promise<Session>;
  getSession(sessionId: string): Promise<Session | null>;
  addMessage(sessionId: string, message: Omit<Message, 'id' | 'timestamp'>): Promise<Message>;
}
