/** Who owns the movement a public link names: found across users, by the token alone. */
export interface SharedSplitIndex {
  /** The owner's user id, while a live movement carries the token. */
  ownerOf(token: string): Promise<string | undefined>
}
