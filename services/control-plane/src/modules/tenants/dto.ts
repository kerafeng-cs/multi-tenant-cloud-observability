import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches } from 'class-validator';

import { TENANT_KEY_RE, trimString } from '../../common/http/validation';
import { DATA_STORE_NAME_RE } from '../../config/data-stores';

const STORE_MESSAGE =
  'must be a data store name: 1-40 lowercase letters, digits or hyphens';

export class CreateTenantDto {
  @ApiProperty({
    example: 'gamma-tenant',
    pattern: TENANT_KEY_RE.source,
    description:
      '1-63 lowercase letters, digits or hyphens; never reusable, even after delete',
  })
  @Transform(trimString)
  @IsString()
  @Matches(TENANT_KEY_RE, {
    message:
      'tenantKey must be 1-63 lowercase letters, digits or hyphens, not starting or ending with a hyphen',
  })
  tenantKey!: string;

  @ApiProperty({
    required: false,
    example: 'shared',
    pattern: DATA_STORE_NAME_RE.source,
    description:
      'VictoriaMetrics store from the data-stores catalog (default "shared"); cannot be changed later',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(DATA_STORE_NAME_RE, { message: `metricsStore ${STORE_MESSAGE}` })
  metricsStore?: string;

  @ApiProperty({
    required: false,
    example: 'shared',
    pattern: DATA_STORE_NAME_RE.source,
    description:
      'OpenSearch store from the data-stores catalog (default "shared"); cannot be changed later',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(DATA_STORE_NAME_RE, { message: `logsStore ${STORE_MESSAGE}` })
  logsStore?: string;
}
