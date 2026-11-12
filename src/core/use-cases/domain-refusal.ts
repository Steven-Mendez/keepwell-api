import type { DomainError } from "../domain/domain"

/** What an assistant reads when the domain refuses a write: the code and detail, or the way out. */
export function domainRefusal(error: DomainError): string {
  if (error.code === "accountClosed") return `Account ${error.detail ?? ""} is closed; reopen it first.`
  return error.message
}
