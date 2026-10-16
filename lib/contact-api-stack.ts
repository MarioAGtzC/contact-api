import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambdaCore from 'aws-cdk-lib/aws-lambda';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';

// Valores privados (correo de destino y secrets de Turnstile) viven en SSM
// Parameter Store, no en el repo ni en el comando de deploy. Ver DEPLOY.md.
const PARAM_PREFIX = '/contact-api';
const TO_EMAIL_PARAM = `${PARAM_PREFIX}/to-email`;
const TURNSTILE_PARAM_PATH = `${PARAM_PREFIX}/turnstile`;

export class ContactApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------------
    // CONFIGURACIÓN — ajusta estos valores a los tuyos
    // ---------------------------------------------------------------------
    const DOMAIN_NAME = 'mario-gutierrez.com';              // tu dominio, sin "https://"
    const SES_FROM_EMAIL = `contact@${DOMAIN_NAME}`;        // dirección de envío en tu dominio
    // Donde recibes los mensajes — se lee de SSM (/contact-api/to-email) al
    // hacer deploy, para no publicar tu correo personal en el repo. Si el
    // parámetro no existe, el deploy falla en vez de desplegar sin destino.
    const SES_TO_EMAIL = ssm.StringParameter.valueForStringParameter(this, TO_EMAIL_PARAM);
    // Todos los frontends que pueden llamar a esta API — agrega aquí cualquier sitio nuevo
    const ALLOWED_ORIGINS = [
      'https://mario-gutierrez.com',
      'https://portfolio.mario-gutierrez.com',
    ];

    // Cada sitio tiene su propia secret de Turnstile, guardada en SSM como
    // SecureString con el hostname del sitio como nombre, ej:
    //   /contact-api/turnstile/mario-gutierrez.com
    // La Lambda las lee en runtime; para agregar un sitio basta con crear su
    // parámetro y sumar el origin a ALLOWED_ORIGINS.

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
    // EVENTOS DE ENTREGA — qué pasó con cada correo después de salir de SES
    // El configuration set publica en EventBridge los eventos de cada envío
    // (entregado, retrasado por el servidor de destino, rebotado, queja,
    // rechazado) y una regla los guarda en un log group. Cada evento trae el
    // MessageId, el mismo que deja el log de la Lambda, y en los retrasos la
    // respuesta del servidor que lo frenó. Los eventos de SES en EventBridge
    // no tienen costo.
    // ---------------------------------------------------------------------
    const configurationSet = new ses.ConfigurationSet(this, 'ContactConfigurationSet');

    configurationSet.addEventDestination('ToEventBridge', {
      destination: ses.EventDestination.eventBus(
        events.EventBus.fromEventBusName(this, 'DefaultEventBus', 'default')
      ),
      events: [
        ses.EmailSendingEvent.DELIVERY,
        ses.EmailSendingEvent.DELIVERY_DELAY,
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.REJECT,
      ],
    });

    // EventBridge solo escribe en log groups cuyo nombre empieza con /aws/events/
    const sesEventsLog = new logs.LogGroup(this, 'SesEventsLog', {
      logGroupName: '/aws/events/contact-api-ses',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new events.Rule(this, 'SesEventsRule', {
      description: 'Guarda los eventos de entrega de los correos de la Contact API',
      eventPattern: {
        source: ['aws.ses'],
        detail: {
          mail: {
            tags: { 'ses:configuration-set': [configurationSet.configurationSetName] },
          },
        },
      },
      targets: [new targets.CloudWatchLogGroup(sesEventsLog)],
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
        // Ruta en SSM de las secrets de Turnstile — la Lambda las lee en
        // runtime, así que nunca aparecen en el template ni en la consola.
        TURNSTILE_PARAM_PATH,
        // Cada envío usa este configuration set para publicar sus eventos
        SES_CONFIGURATION_SET: configurationSet.configurationSetName,
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
    // destinatario, por eso va incluida. Al enviar con configuration set, IAM
    // también lo evalúa como recurso.
    const sesIdentityArn = (identity: string) =>
      this.formatArn({ service: 'ses', resource: 'identity', resourceName: identity });
    contactFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [
          sesIdentityArn(DOMAIN_NAME),
          sesIdentityArn(SES_TO_EMAIL),
          this.formatArn({
            service: 'ses',
            resource: 'configuration-set',
            resourceName: configurationSet.configurationSetName,
          }),
        ],
      })
    );

    // Permiso para leer solo las secrets de Turnstile. Son SecureString con la
    // llave administrada por AWS (aws/ssm), cuya política ya permite descifrar
    // vía SSM dentro de la cuenta — no hace falta un permiso de KMS aparte.
    contactFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParametersByPath'],
        resources: [
          this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: TURNSTILE_PARAM_PATH.slice(1),
          }),
        ],
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
