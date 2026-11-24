import { debtRepaid, isSettled, spendingAmountIn, splitDebts } from "../domain/domain"
import { decimalText } from "../domain/domain/decimal"
import { ShareToken } from "../domain/schema"
import { toDomain } from "../ledger/wire-to-domain"
import type { LedgerReader } from "../ports/ledger-reader"
import type { SharedSplitIndex } from "../ports/shared-splits"

/**
 * What a split expense's public link shows: the expense and each person's share and whether they
 * paid. Nothing else of the ledger (no note, account, category or ids) leaves the server.
 */
export interface SharedSplitView {
  description: string
  date: string
  amount: string
  currency: string
  /** What the expense cost its owner, after the others' shares. */
  owner_share: string
  shares: { person: string; amount: string; currency: string; repaid: string; paid: boolean }[]
}

/** The public page of a shared split, read only and without a session (`GET /shared/:token`). */
export class ViewSharedSplit {
  constructor(
    private readonly index: SharedSplitIndex,
    private readonly ledger: LedgerReader
  ) {}

  /** `undefined` alike for a malformed, unknown or revoked token and for an expense no longer split. */
  async execute(token: string): Promise<SharedSplitView | undefined> {
    if (!ShareToken.safeParse(token).success) return undefined
    const owner = await this.index.ownerOf(token)
    if (owner === undefined) return undefined
    const { transactions, personalDebts } = toDomain(await this.ledger.load(owner))
    const expense = transactions.find((transaction) => transaction.shareToken === token)
    if (!expense) return undefined
    const debts = splitDebts(expense, personalDebts)
    const ownerShare = spendingAmountIn(expense, personalDebts, expense.currency)
    if (debts.length === 0 || ownerShare === undefined) return undefined
    return {
      description: expense.description,
      date: expense.date,
      amount: expense.amount,
      currency: expense.currency,
      owner_share: decimalText(ownerShare.toDecimalPlaces(2)),
      shares: debts.map((debt) => ({
        person: debt.person,
        amount: debt.amount.amount,
        currency: debt.amount.currency,
        repaid: decimalText(debtRepaid(debt)),
        paid: isSettled(debt),
      })),
    }
  }
}
