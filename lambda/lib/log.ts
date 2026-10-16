// Una línea JSON por petición en CloudWatch, sin datos personales (nada de
// nombre, email, mensaje ni IP). Sirve para saber qué sitio mandó qué, por qué
// se rechazó una petición y con qué MessageId salió cada correo de SES.
//
// Para verlas: ver la sección "Logs" de DEPLOY.md.
export interface RequestLog {
  site: string;
  status: number;
  result: 'sent' | 'rejected' | 'error';
  reason?: string;
  errorCodes?: string[];
  messageId?: string;
}

export function logRequest(entry: RequestLog): void {
  console.log(JSON.stringify({ event: 'contact', ...entry }));
}
