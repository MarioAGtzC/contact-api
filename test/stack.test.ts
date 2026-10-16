import { beforeAll, describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ContactApiStack } from '../lib/contact-api-stack';

let template: Template;

// Sintetizar el stack empaqueta la Lambda con esbuild, por eso el timeout amplio.
beforeAll(() => {
  const app = new cdk.App();
  template = Template.fromStack(new ContactApiStack(app, 'TestStack'));
}, 120_000);

describe('ContactApiStack', () => {
  it('crea la Lambda con Node.js 24, 256 MB y 10 s', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      MemorySize: 256,
      Timeout: 10,
      Environment: {
        Variables: Match.objectLike({
          SES_FROM_EMAIL: 'contact@mario-gutierrez.com',
          ALLOWED_ORIGINS: 'https://mario-gutierrez.com,https://portfolio.mario-gutierrez.com',
          TURNSTILE_PARAM_PATH: '/contact-api/turnstile',
        }),
      },
    });
  });

  it('no deja secrets en el template', () => {
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toContain('TURNSTILE_SECRETS');
  });

  it('lee el correo de destino desde SSM al desplegar', () => {
    const params = template.toJSON().Parameters as Record<string, { Type: string; Default?: string }>;
    expect(Object.values(params)).toContainEqual({
      Type: 'AWS::SSM::Parameter::Value<String>',
      Default: '/contact-api/to-email',
    });
  });

  it('solo puede leer las secrets de Turnstile y enviar por SES', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['ses:SendEmail', 'ses:SendRawEmail'],
            Effect: 'Allow',
          }),
          Match.objectLike({
            Action: 'ssm:GetParametersByPath',
            Effect: 'Allow',
            Resource: {
              'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp(':parameter/contact-api/turnstile$')])],
            },
          }),
        ]),
      },
    });
  });

  it('publica los eventos de entrega de SES en un log group', () => {
    template.resourceCountIs('AWS::SES::ConfigurationSet', 1);
    template.hasResourceProperties('AWS::SES::ConfigurationSetEventDestination', {
      EventDestination: Match.objectLike({
        Enabled: true,
        MatchingEventTypes: Match.arrayWith(['delivery', 'deliveryDelay', 'bounce', 'complaint', 'reject']),
        EventBridgeDestination: Match.anyValue(),
      }),
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/events/contact-api-ses',
      RetentionInDays: 30,
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({ source: ['aws.ses'] }),
      Targets: Match.arrayWith([Match.objectLike({ Arn: Match.anyValue() })]),
    });
  });

  it('la Lambda envía con el configuration set y tiene permiso sobre él', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ SES_CONFIGURATION_SET: Match.anyValue() }) },
    });
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).toContain(':configuration-set/');
  });

  it('limita CORS a los sitios permitidos', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowOrigins: ['https://mario-gutierrez.com', 'https://portfolio.mario-gutierrez.com'],
        AllowMethods: ['POST', 'OPTIONS'],
      }),
    });
  });

  it('expone POST /contact', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /contact' });
  });

  it('aplica throttling de 5 req/s con ráfaga de 10', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
    });
  });
});
