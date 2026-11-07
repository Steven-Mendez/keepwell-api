/** How many rows an MCP client wrote for a user since a moment (the hourly write limit). */
export interface McpWriteCounter {
  countSince(userId: string, clientId: string, since: Date): Promise<number>
}
