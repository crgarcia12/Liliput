export interface ConversationHandler {
  handleMessage(sessionId: string, userMessage: string): Promise<string>;
}
