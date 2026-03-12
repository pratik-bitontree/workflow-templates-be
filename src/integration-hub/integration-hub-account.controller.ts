import { Body, Controller, Post, Put } from '@nestjs/common';
import { IntegrationHubService } from './integration-hub.service';

const DEFAULT_USER_ID = '000000000000000000000001';

@Controller('integration-hub/account-connections')
export class IntegrationHubAccountController {
  constructor(private readonly service: IntegrationHubService) {}

  @Post('api-key')
  async saveApiKey(
    @Body() body: { userId?: string; service: string; apiKey: string; user_name?: string },
  ) {
    const uid = body.userId || DEFAULT_USER_ID;
    return this.service.saveApiKey(uid, body.service, body.apiKey, body.user_name);
  }

  @Put('api-key')
  async updateApiKey(
    @Body()
    body: { userId?: string; service: string; accountId: string; apiKey: string; user_name?: string },
  ) {
    const uid = body.userId || DEFAULT_USER_ID;
    return this.service.updateApiKey(uid, body.service, body.accountId, body.apiKey, body.user_name);
  }

  @Post('logout')
  async logout(@Body() body: { userId?: string; service: string; accountId: string }) {
    const uid = body.userId || DEFAULT_USER_ID;
    return this.service.disconnectAccount(uid, body.service, body.accountId);
  }
}
