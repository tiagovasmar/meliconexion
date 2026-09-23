# meli-mcp-connector

Servidor MCP remoto, de **solo lectura**, que conecta tu cuenta de Mercado Libre
con Claude para consultar ventas reales (sin navegar la web de Mercado Libre).

## Cómo funciona (en criollo)

Hay dos "inicios de sesión" distintos, pero están unificados en uno solo gracias
a cómo está armado este servidor:

1. Vos autorizás **una vez** a tu app de Mercado Libre a leer tus ventas (OAuth
   estándar de Mercado Libre).
2. Ese mismo login es, al mismo tiempo, el que usa Claude para conectarse a
   este servidor como "conector personalizado". Este servidor actúa de
   **proxy**: cuando Claude pide un token, este servidor se lo pide a
   Mercado Libre y se lo devuelve tal cual. Cuando Claude llama a una
   herramienta (ej. "traeme las ventas de septiembre"), este servidor usa ese
   mismo token para llamar a la API real de Mercado Libre.

Ventaja de este diseño: **este servidor nunca guarda tus credenciales ni tus
tokens en disco**. Los tokens de acceso/refresh de Mercado Libre quedan
gestionados por la infraestructura de Anthropic (la misma que gestiona
cualquier conector de Claude), cifrados ahí — no en este código, no en el
Excel, no en el chat.

Herramientas que expone (todas de solo lectura):

- `meli_seller_info` — identidad de la cuenta conectada.
- `meli_search_orders` — busca órdenes por rango de fechas / estado, paginado.
- `meli_get_order` — detalle de una orden puntual.
- `meli_sales_summary` — total vendido, cantidad de órdenes y unidades en un
  período (solo ventas `paid`), avisando si el resultado quedó parcial.

No modifica publicaciones, precios, stock ni campañas. No envía mensajes. No
realiza ninguna operación comercial.

## 1. Registrar la aplicación en Mercado Libre

1. Andá a https://developers.mercadolibre.com.ar/devcenter y creá una
   aplicación nueva (o usá una existente si ya tenés una apropiada).
2. Anotá el **App ID (Client ID)** y la **Secret Key (Client Secret)**.
3. Configurá los **permisos funcionales** en modo lectura ("read" y
   "offline_access" para el refresh token). No pidas "write".
4. **Todavía no completes el Redirect URI** — lo hacemos en el paso 3, una vez
   que sepamos la URL final de Render.
5. Si el formulario de creación ofrece la opción de habilitar **PKCE**,
   activala (Claude siempre usa PKCE S256; es la config más segura).

## 2. Deploy en Render (gratis)

Render es la opción más simple para este caso (Node.js, HTTPS automático,
env vars fáciles de administrar, tier gratuito).

1. Subí esta carpeta a un repositorio de GitHub tuyo (podés arrastrar los
   archivos directamente en github.com → "Add file" → "Upload files", no hace
   falta usar git desde la terminal).
2. Entrá a https://render.com, creá una cuenta (podés usar tu cuenta de
   GitHub para entrar) y elegí **New → Web Service**.
3. Conectá el repositorio que acabás de crear.
4. Render va a detectar Node.js automáticamente:
   - Build command: `npm install`
   - Start command: `npm start`
   - Plan: **Free**
5. En **Environment**, cargá estas variables (Add Environment Variable):
   - `MELI_APP_ID` → tu App ID
   - `MELI_APP_SECRET` → tu Secret Key
   - `MELI_AUTH_DOMAIN` → `https://auth.mercadolibre.com.ar`
   - `PUBLIC_URL` → la URL que Render te va a asignar, algo como
     `https://meli-mcp-connector.onrender.com` (Render te la muestra antes de
     que termine el primer deploy; si el nombre del servicio en el paso 3 fue
     `meli-mcp-connector`, la URL sigue ese patrón)
6. Deploy. Cuando termine, entrá a `https://TU-URL.onrender.com/health` y
   deberías ver `{"ok":true,...}`.

> Nota sobre el plan gratuito: el servicio "duerme" tras ~15 minutos sin uso y
> tarda unos segundos en despertar en la siguiente consulta. Para este caso de
> uso (consultas puntuales, no tiempo real) no es un problema.

## 3. Completar el Redirect URI en Mercado Libre

Volvé a la configuración de tu app en Mercado Libre y cargá como
**Redirect URI**, exactamente:

```
https://claude.ai/api/mcp/auth_callback
```

(Sí, es el dominio de Claude, no el de Render — porque el login final que se
completa es el de Claude conectándose a este servidor, que a su vez ya quedó
autenticado contra Mercado Libre en el mismo paso.)

## 4. Conectar el custom connector en Claude

1. En claude.ai: **Configuración → Connectors → Add custom connector**.
2. URL del servidor MCP: `https://TU-URL.onrender.com/mcp`
3. En **Advanced settings**, completá:
   - OAuth Client ID → tu **App ID** de Mercado Libre
   - OAuth Client Secret → tu **Secret Key** de Mercado Libre
4. Guardá y tocá **Connect**. Te va a redirigir a la pantalla de autorización
   de Mercado Libre (elegí el país, iniciá sesión con tu cuenta — **la cuenta
   administradora**, no un colaborador — y autorizá).
5. Volvés a Claude ya conectado.

## 5. Primer uso y bloqueo a tu cuenta

La primera vez que Claude llame a una herramienta, el server loguea en Render
(`Logs`) algo como:

```
Primer login detectado: seller_id=123456789 (TUNICK). Te recomiendo setear ALLOWED_SELLER_ID=123456789...
```

Copiá ese número y cargalo como variable de entorno `ALLOWED_SELLER_ID` en
Render, y hacé un redeploy. A partir de ahí, el servidor va a rechazar
cualquier token que no pertenezca exactamente a esa cuenta — así, si alguna
vez alguien más conecta un token, no puede leer tus datos.

## Costos y límites

- Mercado Libre: la API es gratuita para este uso (consulta de tus propias
  ventas).
- Render plan Free: gratuito, con el sleep de inactividad mencionado arriba.
- Claude: los custom connectors están disponibles en todos los planes; el
  plan gratuito de Claude permite un solo conector personalizado.

## Conectar también Codex

Esta opción mantiene el conector de Claude. Codex se autoriza por separado, con
las mismas herramientas de solo lectura.

1. En Mercado Libre, verificá que **Use PKCE** esté activado para esta aplicación.
   Agregá `https://TU-URL.onrender.com/codex/callback` a sus URIs de redirect,
   conservando `https://claude.ai/api/mcp/auth_callback`. La URI nueva debe
   coincidir exactamente con `PUBLIC_URL` más `/codex/callback`.
2. En Codex, ejecutá:

   ```sh
   codex mcp add panel-meli --url https://TU-URL.onrender.com/mcp --oauth-client-id TU_APP_ID-codex
   ```

   Copiá la **OAuth callback URL** que muestra Codex. Es una dirección local
   `http://127.0.0.1/callback/...`; el puerto se elige al iniciar sesión.
3. En Render, configurá `CODEX_CALLBACK_URL` con esa URL local exacta y
   desplegá la nueva versión del servidor. Nunca cargues el Client Secret
   en Codex: el servidor lo usa internamente al intercambiar los códigos.
4. Ejecutá `codex mcp login panel-meli` y completá la autorización de
   Mercado Libre. Reiniciá Codex para ver las herramientas.

Codex se registra como cliente público con PKCE; por eso esta opción requiere
que PKCE esté habilitado en la aplicación de Mercado Libre. El servidor usa una
URI HTTPS fija para Mercado Libre y devuelve el resultado al callback local
de Codex. El token de Claude no se comparte con Codex.

## Revocar el acceso

- Desde Mercado Libre: "Mis aplicaciones" → tu app → revocar autorización del
  usuario (o eliminar la app directamente).
- Desde Claude: Configuración → Connectors → quitar el conector.
- Cualquiera de las dos invalida el acceso; no hace falta tocar el código.

## Qué NO hace (a propósito)

- No escribe nada en Mercado Libre (publicaciones, precios, stock, mensajes).
- No guarda tokens ni datos de compradores en disco.
- No reemplaza el Excel de costos/proveedores/gastos internos: sigue siendo
  la fuente de esa información, que Mercado Libre no tiene.
