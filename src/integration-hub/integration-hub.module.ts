import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { IntegrationHubController } from './integration-hub.controller';
import { IntegrationHubAccountController } from './integration-hub-account.controller';
import { IntegrationHubOAuthController } from './integration-hub-oauth.controller';
import { OrchestrationController } from './orchestration.controller';
import { IntegrationHubService } from './integration-hub.service';
import { UserSecrets, UserSecretsSchema } from '../schemas/user-secrets.schema';
import { ActivityLog, ActivityLogSchema } from '../schemas/activity-log.schema';
import { NodeMaster, NodeMasterSchema } from '../schemas/node-master.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserSecrets.name, schema: UserSecretsSchema },
      { name: ActivityLog.name, schema: ActivityLogSchema },
      { name: NodeMaster.name, schema: NodeMasterSchema },
    ]),
  ],
  controllers: [
    IntegrationHubController,
    IntegrationHubAccountController,
    IntegrationHubOAuthController,
    OrchestrationController,
  ],
  providers: [IntegrationHubService],
  exports: [IntegrationHubService],
})
export class IntegrationHubModule {}
