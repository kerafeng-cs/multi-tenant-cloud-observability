import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';

import type { AuthUser } from './auth-user';

interface KeycloakPayload {
  sub: string;

  preferred_username?: string;

  realm_access?: {
    roles?: string[];
  };

  groups?: string[];

  vm_account_id?: string | string[];

  metrics_store?: string | string[];

  logs_store?: string | string[];
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),

      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 10,
        jwksUri: config.getOrThrow<string>('KEYCLOAK_JWKS_URI'),
      }),

      issuer: config.getOrThrow<string>('KEYCLOAK_ISSUER'),
      audience: config.getOrThrow<string>('KEYCLOAK_AUDIENCE'),

      algorithms: ['RS256'],
    });
  }

  validate(payload: KeycloakPayload): AuthUser {
    const vmAccountIds = asList(payload.vm_account_id);

    return {
      sub: payload.sub,

      username:
        payload.preferred_username ??
        payload.sub,

      roles:
        payload.realm_access?.roles ??
        [],

      groups:
        payload.groups ??
        [],

      vmAccountIds,

      metricsStores: asList(payload.metrics_store),

      logsStores: asList(payload.logs_store),
    };
  }
}

/** A multivalued claim may come as one string or as an array. */
function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}
