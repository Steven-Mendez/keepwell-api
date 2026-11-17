/**
 * Text only the desktop web has (keyboard shortcuts, the command palette, browser storage, file
 * pickers), which no iOS catalog can hold. Same shape as the generated catalog; everything else on
 * screen comes from the iOS catalogs, so the two apps read the same.
 */
export type WebStrings = Record<
  string,
  { en?: string | Record<string, string>; es: string | Record<string, string> }
>

export const WEB_STRINGS_CORE: WebStrings = {
  "More actions": { es: "Más acciones" },
  Notifications: { es: "Notificaciones" },
  "Notifications, %lld unread": {
    en: {
      one: "Notifications, %lld unread",
      other: "Notifications, %lld unread",
    },
    es: {
      one: "Notificaciones, %lld sin leer",
      other: "Notificaciones, %lld sin leer",
    },
  },
  "Mark as read": { es: "Marcar como leída" },
  "Mark as unread": { es: "Marcar como no leída" },
  "Mark all as read": { es: "Marcar todas como leídas" },
  "Delete read": { es: "Eliminar las leídas" },
  "Delete notification": { es: "Eliminar notificación" },
  "Notification deleted": { es: "Notificación eliminada" },
  "%lld notifications deleted": {
    en: { one: "%lld notification deleted", other: "%lld notifications deleted" },
    es: { one: "%lld notificación eliminada", other: "%lld notificaciones eliminadas" },
  },
  Undo: { es: "Deshacer" },
  Unread: { es: "Sin leer" },
  Yesterday: { es: "Ayer" },
  "Notification options": { es: "Opciones de notificaciones" },
  "Get them in this browser": { es: "Recíbelas en este navegador" },
  "Payments, renewals and budgets reach you even with Keepwell closed.": {
    es: "Pagos, renovaciones y presupuestos te llegan aunque Keepwell esté cerrado.",
  },
  "Turn on": { es: "Activar" },
  "Notifications are blocked for this site. Allow them in the browser's site settings.": {
    es: "Las notificaciones están bloqueadas para este sitio. Permítelas en la configuración del sitio del navegador.",
  },
  "Notifications are on in this browser.": { es: "Las notificaciones están activadas en este navegador." },
  "Turn off": { es: "Desactivar" },
  "Sign in with your account to get notifications in this browser.": {
    es: "Inicia sesión con tu cuenta para recibir notificaciones en este navegador.",
  },
  "We couldn't turn on notifications. Try again.": {
    es: "No pudimos activar las notificaciones. Inténtalo de nuevo.",
  },
  "You're all caught up": { es: "Estás al día" },
  "Payment reminders, budget warnings and proposals from Claude show up here.":
    {
      es: "Aquí aparecen los recordatorios de pago, los avisos de presupuesto y las propuestas de Claude.",
    },
  "Search or jump to…": { es: "Busca o ve a…" },
  "No results.": { es: "Sin resultados." },
  "Toggle sidebar": { es: "Mostrar u ocultar la barra lateral" },
  "Close panel": { es: "Cerrar panel" },
  "Next or previous movement": { es: "Movimiento siguiente o anterior" },
  "column.description": { en: "Description", es: "Descripción" },
  "column.category": { en: "Category", es: "Categoría" },
  "column.account": { en: "Account", es: "Cuenta" },
  "column.amount": { en: "Amount", es: "Monto" },
  "Stored in this browser": { es: "Guardado en este navegador" },
  "welcome.preview.rent": { en: "Rent", es: "Alquiler" },
  "Kept by the browser": { es: "El navegador lo conserva" },
  "May be cleared": { es: "Podría borrarse" },
  "Your data lives in this browser. Export a CSV now and then to keep a copy.": {
    es: "Tus datos viven en este navegador. Exporta un CSV de vez en cuando para tener una copia.",
  },
  "Follow the browser": { es: "Seguir al navegador" },
  "Keepwell uses your browser's language. To use another one only here, choose it below.":
    {
      es: "Keepwell usa el idioma de tu navegador. Para usar otro solo aquí, elígelo abajo.",
    },
  "Deletes the data in this browser.": {
    es: "Borra los datos de este navegador.",
  },
  "Your accounts, cards and transactions are deleted from this browser. This can't be undone.":
    {
      es: "Tus cuentas, tarjetas y movimientos se borran de este navegador. No se puede deshacer.",
    },
  Back: { es: "Atrás" },
  /** The error screens (app/error.tsx and app/global-error.tsx). */
  "Something went wrong": { es: "Algo salió mal" },
  "Keepwell couldn't show this page. Your data is still on this device: reload to try again, or export a CSV to keep a copy.":
    {
      es: "Keepwell no pudo mostrar esta página. Tus datos siguen en este dispositivo: recarga para intentarlo de nuevo o exporta un CSV para guardar una copia.",
    },
  Reload: { es: "Recargar" },
  /** iOS takes these from the system; the web needs them spelled out. */
  Cancel: { es: "Cancelar" },
  /** iOS says "on this iPhone"; on the web the name stays in the browser. */
  "We'll use it to greet you and show it on your cards. It's only stored in this browser.":
    {
      es: "Lo usaremos para saludarte y mostrarlo en tus tarjetas. Solo se guarda en este navegador.",
    },
}

import { WEB_STRINGS_SYNC } from "./web-strings.sync"
import { WEB_STRINGS_ACCOUNT } from "./web-strings.account"
import { WEB_STRINGS_ACCOUNTS } from "./web-strings.accounts"
import { WEB_STRINGS_DEBTS } from "./web-strings.debts"
import { WEB_STRINGS_EDITOR } from "./web-strings.editor"
import { WEB_STRINGS_MERCHANTS } from "./web-strings.merchants"
import { WEB_STRINGS_RECURRING } from "./web-strings.recurring"
import { WEB_STRINGS_RULES } from "./web-strings.rules"
import { WEB_STRINGS_SETTINGS } from "./web-strings.settings"
import { WEB_STRINGS_SUMMARY } from "./web-strings.summary"

export const WEB_STRINGS: WebStrings = {
  ...WEB_STRINGS_CORE,
  ...WEB_STRINGS_EDITOR,
  ...WEB_STRINGS_ACCOUNTS,
  ...WEB_STRINGS_SETTINGS,
  ...WEB_STRINGS_SUMMARY,
  ...WEB_STRINGS_RECURRING,
  ...WEB_STRINGS_DEBTS,
  ...WEB_STRINGS_RULES,
  ...WEB_STRINGS_ACCOUNT,
  ...WEB_STRINGS_SYNC,
  ...WEB_STRINGS_MERCHANTS,
}
