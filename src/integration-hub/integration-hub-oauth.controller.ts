import { Controller, Get, Query } from '@nestjs/common';
import { IntegrationHubService } from './integration-hub.service';

const DEFAULT_USER_ID = '000000000000000000000001';

@Controller('integration-hub/oauth')
export class IntegrationHubOAuthController {
  constructor(private readonly service: IntegrationHubService) {}

  @Get('login')
  getLoginUrl(@Query('service') service: string, @Query('userId') userId: string) {
    const uid = userId || DEFAULT_USER_ID;
    const url = this.service.getOAuthLoginUrl(service, uid);
    return { url };
  }

  @Get('auth-check')
  async authCheck(@Query('service') service: string, @Query('userId') userId: string) {
    const uid = userId || DEFAULT_USER_ID;
    return this.service.getOAuthAuthCheck(uid, service);
  }
}
