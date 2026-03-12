import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { IntegrationHubService } from './integration-hub.service';

/** Response shapes aligned with GrowStack UserMicroService integrationHub (no auth; userId from query/body). */
@Controller('integration-hub/integrations')
export class IntegrationHubController {
  constructor(private readonly service: IntegrationHubService) {}

  @Get('categories')
  async getCategories(@Query('userId') userId: string) {
    const data = await this.service.getCategories();
    return { success: true, data };
  }

  @Get('details')
  async getDetails(@Query('userId') userId: string) {
    const uid = userId || '000000000000000000000001';
    const data = await this.service.getIntegrationDetails(uid);
    return { success: true, data };
  }

  @Get('connectedAccounts')
  async getConnectedAccounts(@Query('userId') userId: string, @Query('service') service: string) {
    const uid = userId || '000000000000000000000001';
    const connectedAccounts = await this.service.getConnectedAccounts(uid, service);
    return { success: true, connectedAccounts };
  }

  @Post('setPrimaryAccount')
  async setPrimary(@Body() body: { userId?: string; service: string; accountId: string }) {
    const uid = body.userId || '000000000000000000000001';
    const response = await this.service.setPrimaryAccount(uid, body.service, body.accountId);
    return { success: true, response };
  }

  @Post('PostLogActivity')
  @HttpCode(HttpStatus.CREATED)
  async logActivity(@Body() body: { userId?: string; action: string; integration: string; accountEmail?: string; accountId?: string; details?: string }) {
    const uid = body.userId || '000000000000000000000001';
    return this.service.logActivity({ ...body, userId: uid });
  }

  @Get('getActivityLogs')
  async getActivityLogs(@Query('userId') userId: string, @Query('limit') limit: string) {
    const uid = userId || '000000000000000000000001';
    const result = await this.service.getActivityLogs(uid, limit ? parseInt(limit, 10) : 30);
    return result;
  }

  @Get('drive-picker-token')
  async getDrivePickerToken(@Query('userId') userId: string) {
    const uid = userId || '000000000000000000000001';
    return this.service.getDrivePickerToken(uid);
  }
}
