// Escapa HTML del usuario antes de insertarlo en el template — sin esto,
// alguien podría meter <script> o markup propio en "name" o "message" y
// romper el layout del correo (o intentar un ataque tipo XSS/HTML injection).
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function getWordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function getInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((n) => n[0])
    .join('')
    .toUpperCase();
}

// Etiqueta corta del sitio que envió el formulario, para la barra del email.
export const SITE_LABELS: Record<string, string> = {
  'mario-gutierrez.com': 'resume',
  'portfolio.mario-gutierrez.com': 'portfolio',
};

export function getSiteLabel(requestOrigin: string): string {
  try {
    const host = new URL(requestOrigin).hostname.replace(/^www\./, '');
    return SITE_LABELS[host] ?? host;
  } catch {
    return 'unknown';
  }
}

// Bloques opcionales del template: <!--IF:key-->...<!--ENDIF:key-->.
// Si `present` no incluye la key, se borra el bloque completo; si la incluye,
// solo se quitan los marcadores y el contenido queda.
export function stripConditionalBlocks(html: string, present: Set<string>): string {
  return html.replace(
    /<!--IF:(\w+)-->([\s\S]*?)<!--ENDIF:\1-->/g,
    (_match, key: string, inner: string) => (present.has(key) ? inner : '')
  );
}

export function renderTemplate(
  template: string,
  vars: Record<string, string>,
  present: Set<string>
): string {
  let html = stripConditionalBlocks(template, present);
  for (const [key, value] of Object.entries(vars)) {
    html = html.split(`{{${key}}}`).join(value);
  }
  return html;
}
