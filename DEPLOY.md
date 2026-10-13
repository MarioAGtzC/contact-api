# Contact API

API serverless para el formulario de contacto de tu página. Recibe `name`,
`email`, `message` y un token de Turnstile; valida el captcha server-side,
calcula metadata (IP, user-agent, fecha, conteo de palabras, iniciales) y
envía el mensaje por email vía SES.

**Arquitectura:** API Gateway (HTTP API, con throttling nativo) → Lambda → SES## 0. Requisitos previos

- Cuenta de AWS con credenciales configuradas (`aws configure`)
- Node.js 18+
- Una cuenta de [Cloudflare](https://dash.cloudflare.com) (gratis) para Turnstile

## 1. Instalar dependencias

```bash
npm install
```

## 2. Configurar SES

SES empieza en modo **sandbox**: solo puede enviar a direcciones ya verificadas.

```bash
# Verifica el email que va a RECIBIR los mensajes (tu Hotmail)
aws ses verify-email-identity --email-address tu-email@hotmail.com
```

Revisa esa bandeja (incluida la carpeta de spam) y confirma el correo de AWS.
El remitente (`SES_FROM_EMAIL`, tu dominio) se verifica aparte en el paso 3
de abajo — no hace falta verificarlo con este comando, eso lo hace el DKIM
del dominio.

Para producción real (poder recibir mensajes sin este límite de sandbox),
puedes pedir salir del sandbox desde la consola de SES → **Account
dashboard** → **Request production access** — aunque para este proyecto,
donde `SES_TO_EMAIL` casi nunca cambia, el sandbox no te limita en la práctica.

## 3. Verificar tu dominio en SES (DKIM) — dominio en Squarespace

El stack ya crea el `EmailIdentity` para tu dominio. Como tu dominio está en
Squarespace (no en Route 53), CDK **no puede** agregar los registros DNS por
ti — los agregas a mano una sola vez.

1. Edita `SES_FROM_EMAIL` / `DOMAIN_NAME` en `lib/contact-api-stack.ts` con tu dominio real.
2. Corre el deploy (ver paso 7 más abajo). Al terminar, en los `Outputs` vas a
   ver algo como:
   ```
   ContactApiStack.DkimRecords = HOST: abc123._domainkey.tudominio.com  VALUE: abc123.dkim.amazonses.com | HOST: ...
   ```
3. Copia esos 3 pares HOST/VALUE.
4. En Squarespace: **Settings → Domains → [tu dominio] → DNS Settings**
   (o desde el nuevo panel: **Domains → tudominio.com → DNS**).
5. Por cada uno de los 3 registros, agrega un nuevo registro:
   - **Type**: `CNAME`
   - **Host**: pega el valor de `HOST` (Squarespace a veces solo pide la
     parte antes de tu dominio, ej. `abc123._domainkey` sin repetir
     `.tudominio.com` — revisa el placeholder del campo)
   - **Data/Value**: pega el valor de `VALUE`
6. Guarda. La propagación puede tardar de minutos a un par de horas.
7. Verifica el estado en la consola de AWS: **SES → Verified identities →
   tudominio.com** — cuando el status pase a "Verified" con DKIM en verde,
   ya puedes enviar desde `contacto@tudominio.com`.

> Nota: verificar el dominio para **enviar** (`SES_FROM_EMAIL`) es distinto a
> verificar el email para **recibir** (`SES_TO_EMAIL`, tu Hotmail) — ese
> sigue el proceso del paso 2 de abajo (mientras SES esté en sandbox).

## 5. Configurar Turnstile (captcha)

1. Ve a [dash.cloudflare.com](https://dash.cloudflare.com) → **Turnstile**
   (no necesitas tener tu dominio en Cloudflare).
2. Crea un site, agrega tu dominio.
3. Copia el **Site Key** (pública) y el **Secret Key** (privada).

## 6. Editar configuración

Abre `lib/contact-api-stack.ts` y cambia:

```typescript
const DOMAIN_NAME = 'tudominio.com';
const SES_FROM_EMAIL = `contacto@${DOMAIN_NAME}`;
const ALLOWED_ORIGIN = 'https://tu-sitio.com';
```

## 7. Desplegar

Primera vez en esta cuenta/región, necesitas hacer bootstrap una sola vez:

```bash
npx cdk bootstrap
```

Luego despliega pasando como contexto tu correo de destino y las Secret Keys
de Turnstile de cada widget (así no quedan escritas en el código):

```bash
npx cdk deploy -c toEmail=TU_EMAIL -c turnstileSecret=SECRET_WIDGET_MARIO -c turnstileSecretGreenie=SECRET_WIDGET_GREENIE
```

Los tres son obligatorios: si falta alguno, el deploy se detiene con un error
en vez de desplegar con un valor vacío.

Al terminar, la terminal imprime algo como:

```
Outputs:
ContactApiStack.ApiUrl = https://abc123xyz.execute-api.us-east-1.amazonaws.com/contact
```

Esa es la URL que usas en tu frontend. Este mismo deploy es el que imprime
el output `DkimRecords` del paso 3 — cópialo y pégalo en Squarespace después
de este comando.

## 8. Frontend

```bash
npm install @marsidev/react-turnstile
```

```tsx
import { Turnstile } from '@marsidev/react-turnstile';

const [turnstileToken, setTurnstileToken] = useState('');

<Turnstile siteKey="TU_SITE_KEY_PUBLICA" onSuccess={setTurnstileToken} />

// al enviar:
await fetch('https://abc123xyz.execute-api.us-east-1.amazonaws.com/contact', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, email, message, turnstileToken }),
});
```

Ya no mandas `ip`, `device_info`, `time`, `word_count`, `initials` ni
`origin` desde el cliente — la Lambda los calcula o los toma de los headers
del request (`Referer`/`Origin`, `User-Agent`, IP de origen).

## Template del correo

El HTML que recibes por email vive en `lambda/email-template.html`, con
placeholders `{{variable}}` (name, email, message, initials, time,
word_count, subject, origin, device_info, ip). Para cambiar el diseño, edita
ese archivo directamente — no hace falta tocar `contact.ts`. El contenido
del usuario (`name`, `message`, `email`) se escapa automáticamente antes de
insertarse en el HTML, para evitar que alguien inyecte markup propio en el
formulario.

## Comandos útiles

| Comando | Qué hace |
|---|---|
| `npx cdk diff` | Muestra qué cambiaría antes de desplegar |
| `npx cdk deploy` | Despliega/actualiza el stack |
| `npx cdk destroy` | Elimina todo lo creado (para no dejar nada corriendo) |
| `npx cdk synth` | Genera el CloudFormation template sin desplegar |

## Costo esperado

Para tráfico de un portafolio personal (cientos de mensajes/mes), el costo
real es **$0–$0.05/mes** — Lambda, API Gateway y SES están muy por debajo de
sus free tiers a ese volumen. Configura una alarma de billing en CloudWatch
a $1-5 si quieres dormir tranquilo.

## Notas de seguridad

- El throttling está configurado a 5 req/s sostenidos, ráfaga de 10 — a nivel
  global de la API, no por IP. Para limitar por IP necesitarías AWS WAF
  (tiene costo fijo ~$6/mes, omitido aquí a propósito por ser overkill para
  este volumen de tráfico).
- El captcha de Turnstile es la defensa principal contra spam/bots.
- Nunca subas tu `TURNSTILE_SECRET_KEY` a git — se pasa como contexto de CDK
  o mejor aún, guárdala en AWS Secrets Manager para un setup más robusto.
