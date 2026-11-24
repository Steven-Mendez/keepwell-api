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
  "Edit split": { es: "Editar división" },
  "Removing someone deletes their debt. Repayments they deposited stay in their accounts.": {
    es: "Quitar a alguien elimina su deuda. Los abonos que depositó se quedan en sus cuentas.",
  },
  "Split with": { es: "Dividido con" },
  Pending: { es: "Pendiente" },
  "Paid %@ of %@": { es: "Pagó %@ de %@" },
  "Mark as paid": { es: "Marcar como pagado" },
  "Mark as unpaid": { es: "Marcar como no pagado" },
  "Mark as unpaid?": { es: "¿Marcar como no pagado?" },
  "%@ paid you %@": { es: "%@ te pagó %@" },
  "Public link": { es: "Enlace público" },
  "Send a link so each person sees how much to pay, without an account.": {
    es: "Envía un enlace para que cada persona vea cuánto pagar, sin necesidad de cuenta.",
  },
  "Anyone with the link sees what each person owes and who already paid. Only you can change it.": {
    es: "Quien tenga el enlace ve cuánto debe cada persona y quién ya pagó. Solo tú puedes cambiarlo.",
  },
  "Share link": { es: "Compartir enlace" },
  "Copy link": { es: "Copiar enlace" },
  "Link copied": { es: "Enlace copiado" },
  "Stop sharing": { es: "Dejar de compartir" },
  Done: { es: "Listo" },
  "Loading…": { es: "Cargando…" },
  "This link is no longer available.": { es: "Este enlace ya no está disponible." },
  "We couldn't load this expense. Try again.": { es: "No pudimos cargar este gasto. Intenta de nuevo." },
  "Whoever paid the bill": { es: "Quien pagó la cuenta" },
  "Shared from Keepwell. Only the person who paid the bill can change it.": {
    es: "Compartido desde Keepwell. Solo quien pagó la cuenta puede cambiarlo.",
  },
}
