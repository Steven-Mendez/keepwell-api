# Plan: monetización de Keepwell

Cómo se paga Keepwell sin traicionar su idea: una app de finanzas personales en dos monedas cuyos
datos viven en el dispositivo. Lo local es gratis y lo seguirá siendo. La nube (sincronizar entre
iPhone y web, y conectar Claude por MCP) es lo que tiene precio.

Decisión tomada: al lanzar no hay suscripción. El sync es gratis con cuenta, el MCP se abre con una
compra única dentro de la app de iOS ("invítame un café"), y el sync pasa a suscripción el día que la
app supere un umbral de usuarios. Quienes compraron el café reciben entonces un año de Pro gratis.
Todo el cobro pasa por la App Store; la web no vende nada.

Este documento decide capas, precios y canales. Cómo la API lo hace cumplir (tabla `entitlements`,
capacidades, bandera de acceso anticipado, webhooks) está en [`PLAN_API.md`](PLAN_API.md).

Fecha: noviembre 2026.

---

## 1. Principios

- **Local gratis, siempre.** La app completa en iPhone y web sin cuenta, incluido el respaldo y la
  restauración con el `.json`. Es la red de seguridad del usuario, su forma de cambiar de teléfono y
  la prueba de que los datos son suyos. No se quita para empujar la suscripción: un archivo manual no
  compite con un sync automático, y sin él la app pierde confianza y reseñas.
- **La nube se paga.** Sync y MCP cuestan dinero y tiempo de mantenimiento, y son lo que la gente
  valora en una app de finanzas: no pensar en respaldos y tener a alguien que mire los números.
- **Una sola vía de sync.** CloudKit se retira. Mantener una sincronización gratuita paralela
  vaciaría de valor la de pago y duplica trabajo.
- **Nunca "gratis para siempre" salvo de lo local.** En la tienda y en la web se dice "gratis" o
  "gratis durante el acceso anticipado".
- **Nada que rompa la confianza.** Sin anuncios, sin venta de datos, sin IA dentro de la app pagada
  con la llave de API del autor para usuarios gratis. El MCP es mejor: cada quien trae su propia
  suscripción a Claude.

---

## 2. Capas

| Capa | Qué incluye | Precio |
| --- | --- | --- |
| Local | La app completa en iPhone y web, respaldo y restauración `.json` | Gratis, siempre |
| Nube | Cuenta y sync entre iPhone y web | Gratis hasta superar el umbral de usuarios (sección 3) |
| Supporter | Lo anterior más el conector MCP para Claude y otros clientes | Una compra única en la app de iOS, "invítame un café" |
| Pro | Sync entre iPhone y web, más el MCP | Suscripción, solo a partir del umbral (sección 4) |

El sync pertenece a Pro desde el diseño aunque hoy sea gratis: la API ya lo trata como capacidad de
pago concedida a todos por la bandera de acceso anticipado. Activar Pro no cambia código.

---

## 3. Lanzamiento y umbral

### Lo que habrá el día del lanzamiento

- La app gratis, local, en App Store y web.
- Cuenta con Sign in with Apple, por invitación al principio.
- Sync entre iPhone y web gratis para quien tiene cuenta. La pantalla de cuenta dice "Sync incluido
  en el acceso anticipado" para que nadie lo lea como permanente.
- "Invítame un café" como compra única dentro de la app de iOS. Activa `supporter` y con ello el
  MCP, en el iPhone y en la web, porque el plan vive en la cuenta.
- La web no vende nada. A quien pida el MCP desde la web se le dice que el café se compra en el
  iPhone.
- Nada más de pago. Sin suscripción.

### El umbral

El sync pasa a suscripción cuando la app supere una cantidad de usuarios con cuenta. La cifra se fija
en este documento cuando se acerque; como referencia, dos medidas razonables:

| Medida | Valor orientativo | Por qué |
| --- | --- | --- |
| Cuentas activas en el último mes | 300 a 500 | Es donde el servidor empieza a salir de la capa gratuita y donde mantenerlo deja de ser un hobby |
| Factura de AWS | más de 10 USD al mes dos meses seguidos | Señal objetiva, independiente de cómo se cuente "usuario" |

Se cumple cualquiera de las dos y se arranca la secuencia de la sección 7.

### Qué pasa con cada quien al cruzar el umbral

| Quién | Qué recibe |
| --- | --- |
| Compró el café (supporter) | Un año de Pro gratis desde la activación. Conserva el MCP después, aunque no renueve |
| Tenía cuenta sin café | Aviso con antelación y un período de gracia corto (a decidir, por ejemplo 30 días). Después, sync solo con Pro; sus datos siguen en local y en el `.json` |
| Se registra después del umbral | Sync con Pro desde el principio |

La API no hace nada especial para esto: `grandfathered` con vencimiento a un año para los supporters
y la bandera `early_access.cloud_sync` en `false` para el resto.

---

## 4. Precios

Orientativos, en USD, para cuando exista Pro. Se fijan al activarlo, no antes.

| Plan | Precio | Nota |
| --- | --- | --- |
| Pro mensual | 3.99 | Ancla; pocos lo eligen |
| Pro anual | 29.99 | Donde conviene que caiga la mayoría |
| Pro de por vida | 69.99 | Para quien no quiere suscripciones. Es "mientras exista el servicio", y así se dice |
| Café (supporter) | 2.99, 4.99 o 9.99 | Tres productos no consumibles, cada uno activa el MCP. La App Store no permite monto libre, así que el usuario elige el tamaño del café |

Referencias: Copilot y YNAB cobran entre 95 y 110 al año; Monefy y Spendee entre 25 y 40. Con precios
regionales de la App Store el anual puede quedar en 15 a 20 en Latinoamérica sin tocar el precio en
Estados Unidos.

Relación entre supporter y Pro: quien compró el café recibe un año de Pro al activarse la suscripción y
conserva el MCP después aunque no renueve. Pro incluye el MCP, así que nadie paga dos veces por lo
mismo.

---

## 5. Canales

Un solo canal: la App Store. Vende el café hoy y la suscripción Pro cuando exista. La web no cobra.

| Qué | Cómo | Comisión |
| --- | --- | --- |
| Café (supporter) | Tres productos no consumibles con StoreKit 2 | 30 %, o 15 % con el Small Business Program |
| Pro (futuro) | Suscripción auto-renovable con StoreKit 2 | Igual |

Decisiones que siguen de esto:

- **Small Business Program.** Hay que solicitarlo en App Store Connect; no es automático. Baja la
  comisión al 15 % mientras se facture menos de un millón de dólares al año. Pedirlo antes de
  publicar el café.
- **RevenueCat es opcional.** Con un producto no consumible y una API propia que ya guarda el plan
  por cuenta, StoreKit 2 más la verificación en el servidor alcanza. RevenueCat entra si al llegar la
  suscripción se quiere ahorrar el manejo de renovaciones, reembolsos y períodos de gracia.
- **Sin merchant of record, sin Payoneer, sin PayPal.** Desaparecen las dudas de cobro por web desde
  Nicaragua. Apple paga a un banco nicaragüense.
- **Un solo derecho de uso por cuenta.** La compra se hace con sesión iniciada; la API la verifica y
  la guarda en `entitlements`. Web, iPhone y MCP leen lo mismo.

### Reglas de Apple que condicionan el diseño

- Un no consumible exige un botón de "restaurar compras". Aquí restaurar es sincronizar con la App
  Store y volver a consultar el plan en la API.
- La app describe lo que se compra: "Apoya Keepwell y conecta Claude a tus finanzas". El MCP se usa
  fuera de la app, pero la compra se hace dentro, así que no hay conflicto con las reglas de pago.
- Las compras dentro de la app no pueden enlazar a formas de pago externas. Como no las hay, no
  aplica.

### Cobrar desde Nicaragua

- Apple paga por transferencia bancaria a bancos en Nicaragua. Su tabla de pagos lista al país con
  el córdoba como moneda de cuenta y un mínimo de 90 USD por pago; las ventas se reportan en USD y
  Apple convierte al pagar. Al registrar el banco, si ofrece USD como moneda de cuenta, usar una
  cuenta en dólares para evitar la conversión de Apple.
- Formulario W-8BEN en App Store Connect. Nicaragua no tiene tratado fiscal con Estados Unidos;
  Apple históricamente no retiene impuesto estadounidense sobre ventas de apps a desarrolladores
  extranjeros, pero hay que confirmarlo en Tax Setup antes de contar con el ingreso completo.
- El ingreso se declara en Nicaragua ante la DGI. Consultar a un contador local antes del primer
  pago.
- Dejar banco, formulario y Small Business Program listos antes de publicar, para que el primer
  pago no se atasque.

---

## 6. Cómo se vincula el café con la cuenta

1. El usuario inicia sesión en la app de iOS (si no tiene cuenta, la crea en ese momento: el MCP la
   necesita de todos modos).
2. Pulsa "invítame un café", elige el tamaño y paga con StoreKit 2.
3. La app manda a la API la transacción firmada por Apple. La API verifica la firma con las claves
   de Apple, comprueba que el `originalTransactionId` no esté ya usado por otra cuenta, y concede
   `supporter` a la cuenta con sesión.
4. En segundos `GET /me` devuelve la capacidad `mcp`. La app muestra cómo conectar Claude; la web
   lo muestra también la próxima vez que se abre.
5. Si Apple reembolsa, su notificación llega a la API y `supporter` se revoca. Si el usuario cambia
   de iPhone, "restaurar compras" repite el paso 3.

`supporter` no caduca. Si en el futuro el MCP consume recursos que cuesten dinero por usuario, se
revisa, pero avisando y con antelación.

---

## 7. Cuándo y cómo activar Pro

Disparador: el umbral de la sección 3. Antes de eso, no, aunque haya quien lo pida; cobrar el sync
mientras es inestable o mientras los usuarios caben en la capa gratuita solo añade soporte.

Secuencia:

1. Fijar precios y crear la suscripción en App Store Connect. Las notificaciones del App Store
   Server ya escriben en `entitlements`; solo hay que añadir el vencimiento y las renovaciones. Sin
   merchant of record, como dice la sección 5.
2. Versión de iOS con StoreKit 2 y la pantalla de Pro, aprobada por Apple.
3. Conceder `grandfathered` con un año de vencimiento a todas las cuentas con `supporter`.
4. Aviso dentro de la app, en la web y por correo: fecha de activación, qué cambia, qué recibe cada
   quien. Dos a cuatro semanas de margen.
5. Bandera `early_access.cloud_sync` a `false` el día anunciado.
6. Un mes después, revisar bajas, soporte y conversión, y ajustar precios regionales si hace falta.

---

## 8. Lo que no se hará

- Quitar exportar e importar el `.json`.
- Anuncios o venta de datos.
- IA dentro de la app con costo por uso cargado al autor.
- Cobrar el sync antes de que sea estable.
- Abrir el MCP o el sync a cualquiera sin registro por invitación hasta que ambos estén probados.

---

## 9. Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Al cobrar el sync, usuarios del acceso anticipado se sienten engañados | Un año gratis para supporters, gracia y aviso con antelación para el resto, y el texto "acceso anticipado" visible desde el día uno |
| Una oleada de cafés justo antes del umbral para asegurar el año gratis | Es aceptable: cada café paga de sobra su año de servidor |
| Apple retiene impuesto estadounidense por falta de tratado | Confirmar en Tax Setup de App Store Connect antes de fijar precios |
| Compra reembolsada por Apple después de activar el MCP | Las notificaciones del App Store Server avisan del reembolso y la API revoca `supporter` |
| Usuario solo de web que quiere el MCP | No puede comprar. Se acepta: el público objetivo tiene iPhone, y la web lo explica |
| Apple rechaza la compra por no tener "restaurar compras" | La pantalla del café incluye restaurar, que sincroniza con la App Store y vuelve a pedir `GET /me` |
| Precios regionales demasiado bajos frente al costo por usuario | El costo por usuario es centavos; el riesgo real es el tiempo del autor, no la factura de AWS |
