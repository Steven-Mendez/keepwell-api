import type { WebStrings } from "./web-strings"

/**
 * Debts texts come from the iOS `debts` and `home` catalogs; these are the web's own until iOS ships
 * the same screens: depositing a repayment and a split movement's share.
 */
export const WEB_STRINGS_DEBTS: WebStrings = {
  "Deposit into account": { es: "Depositar en cuenta" },
  "Don't deposit": { es: "No depositar" },
  "Records an income in %@. It changes the balance but doesn't count as income: the money only came back.": {
    es: "Registra un ingreso en %@. Cambia el saldo pero no cuenta como ingreso: el dinero solo volvió.",
  },
  "%@ · deposited": { es: "%@ · depositado" },
  "Delete repayment": { es: "Eliminar abono" },
  "Delete this repayment?": { es: "¿Eliminar este abono?" },
  "The income it deposited is deleted too, and the balance goes back.": {
    es: "También se elimina el ingreso que depositó y el saldo vuelve a como estaba.",
  },
  "Repayments you deposited stay as movements in their accounts.": {
    es: "Los abonos que depositaste se quedan como movimientos en sus cuentas.",
  },
  "Your share: %@ of %@": { es: "Tu parte: %@ de %@" },
  "Split with %@": { es: "Dividido con %@" },
}
