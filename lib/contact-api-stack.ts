import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambdaCore from 'aws-cdk-lib/aws-lambda';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';

// Lee un valor de contexto (-c key=value) y detiene el deploy si falta, en vez
// de desplegar con un valor vacío sin avisar.
function requireContext(scope: Construct, key: string): string {
  const value = scope.node.tryGetContext(key);
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Falta el contexto "${key}". Despliega con: npx cdk deploy -c ${key}=...`);
  }
  return value.trim();
}

export class ContactApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------------
    // CONFIGURACIÓN — ajusta estos valores a los tuyos
    // ---------------------------------------------------------------------
    const DOMAIN_NAME = 'mario-gutierrez.com';              // tu dominio, sin "https://"
    const SES_FROM_EMAIL = `contact@${DOMAIN_NAME}`;        // dirección de envío en tu dominio
    // Donde recibes los mensajes — se pasa al hacer deploy (-c toEmail=...) para
    // no publicar tu correo personal en el repo.
    const SES_TO_EMAIL = requireContext(this, 'toEmail');
    // Todos los frontends que pueden llamar a esta API — agrega aquí cualquier sitio nuevo
    const ALLOWED_ORIGINS = [
      'https://mario-gutierrez.com',
      'https://portfolio.mario-gutierrez.com',
    ];

    // Cada sitio puede tener su propio site/secret de Turnstile — agrega aquí
    // el context key correspondiente y pásalo al hacer deploy:
    // cdk deploy -c turnstileSecret=xxxx -c turnstileSecretGreenie=yyyy
    const TURNSTILE_SECRETS: Record<string, string> = {
      'https://mario-gutierrez.com': requireContext(this, 'turnstileSecret'),
      // El portfolio usa el widget de greenie (mismo site key en su nuevo dominio)
      'https://portfolio.mario-gutierrez.com': requireContext(this, 'turnstileSecretGreenie'),
    };

    // ---------------------------------------------------------------------
    // SES — verificación de dominio + DKIM
    // Tu dominio está en Squarespace (no Route 53), así que CDK NO puede
    // agregar los registros DNS automáticamente. Después del deploy, revisa
    // el output "DkimRecords" y pega esos 3 CNAME en el panel DNS de
    // Squarespace a mano (instrucciones en el README).
    // ---------------------------------------------------------------------
    const emailIdentity = new ses.EmailIdentity(this, 'ContactDomainIdentity', {
      identity: ses.Identity.domain(DOMAIN_NAME),
      dkimSigning: true,
    });

    new cdk.CfnOutput(this, 'DkimRecords', {
      value: cdk.Fn.join(
        ' | ',
        emailIdentity.dkimRecords.map((r) => `HOST: ${r.name}  VALUE: ${r.value}`)
      ),
      description: 'Agrega estos 3 registros CNAME en el DNS de Squarespace',
    });

    // ---------------------------------------------------------------------
    // LAMBDA
    // ---------------------------------------------------------------------
    const contactFn = new lambda.NodejsFunction(this, 'ContactHandler', {
      entry: 'lambda/contact.ts',
      handler: 'handler',
      runtime: lambdaCore.Runtime.NODEJS_24_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        SES_FROM_EMAIL,
        SES_TO_EMAIL,
        // Env vars solo aceptan strings — se unen con coma y el handler las separa
        ALLOWED_ORIGINS: ALLOWED_ORIGINS.join(','),
        // Secrets de Turnstile por origin — NUNCA hardcodeadas aquí; se pasan
        // al hacer deploy con -c turnstileSecret=... -c turnstileSecretGreenie=...
        TURNSTILE_SECRETS: JSON.stringify(TURNSTILE_SECRETS),
      },
      bundling: {
        minify: true,
        // NodejsFunction solo empaqueta el código TS/JS con esbuild — un
        // archivo .html leído en runtime con fs.readFileSync no se copia
        // solo, hay que decírselo explícitamente aquí.
        commandHooks: {
          beforeBundling: () => [],
          afterBundling: (inputDir, outputDir) => {
            // En Windows, inputDir/outputDir vienen con backslashes (C:\Users\...).
            // Si los insertamos tal cual dentro de un string de JS ('...'),
            // secuencias como "\U" o "\E" se interpretan como escapes inválidos
            // y el backslash se pierde, corrompiendo la ruta. Normalizamos a "/"
            // (Node los acepta igual en Windows) antes de insertarlos.
            const src = `${inputDir}/lambda/email-template.html`.replace(/\\/g, '/');
            const dest = `${outputDir}/email-template.html`.replace(/\\/g, '/');
            return [
              `node -e "require('fs').copyFileSync('${src}', '${dest}')"`,
            ];
          },
          beforeInstall: () => [],
        },
      },
    });

    // Permiso para que la Lambda pueda mandar emails vía SES — solo desde tu
    // dominio. Mientras SES esté en sandbox, IAM también evalúa la identidad del
    // destinatario, por eso va incluida.
    const sesIdentityArn = (identity: string) =>
      this.formatArn({ service: 'ses', resource: 'identity', resourceName: identity });
    contactFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [sesIdentityArn(DOMAIN_NAME), sesIdentityArn(SES_TO_EMAIL)],
      })
    );

    // ---------------------------------------------------------------------
    // API GATEWAY (HTTP API) — más barato que REST API, suficiente aquí
    // ---------------------------------------------------------------------
    const httpApi = new apigw.HttpApi(this, 'ContactApi', {
      apiName: 'contact-api',
      corsPreflight: {
        allowOrigins: ALLOWED_ORIGINS,
        allowMethods: [apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.OPTIONS],
        allowHeaders: ['Content-Type'],
        maxAge: cdk.Duration.hours(1),
      },
      createDefaultStage: true,
    });

    httpApi.addRoutes({
      path: '/contact',
      methods: [apigw.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('ContactIntegration', contactFn),
    });

    // ---------------------------------------------------------------------
    // THROTTLING NATIVO — sin WAF, sin costo extra
    // Limita el throughput global de la API para evitar picos/costos
    // descontrolados. No es por-IP; eso requeriría WAF (omitido a propósito).
    // ---------------------------------------------------------------------
    const cfnStage = httpApi.defaultStage?.node.defaultChild as apigw.CfnStage;
    cfnStage.defaultRouteSettings = {
      throttlingRateLimit: 5,   // 5 requests/segundo sostenidos
      throttlingBurstLimit: 10, // ráfaga máxima de 10 de golpe
    };

    // ---------------------------------------------------------------------
    // OUTPUT — URL de la API para usar en el frontend
    // ---------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `${httpApi.apiEndpoint}/contact`,
      description: 'URL del endpoint de contacto — úsala en el frontend',
    });
  }
}
