import type { WebStrings } from "./web-strings"

/**
 * Recurring texts come from the iOS catalogs (`recurring`, `home`, `createtransaction`); these are
 * the desktop's own. On iPhone a payment is unlinked with a swipe, so it needs no "Undo" notice.
 */
export const WEB_STRINGS_RECURRING: WebStrings = {
  "Payment unlinked": { es: "Pago desasociado" },
}
