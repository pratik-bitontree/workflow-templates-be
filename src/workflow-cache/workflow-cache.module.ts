import { Global, Module } from '@nestjs/common';
import { WorkflowCacheService } from './workflow-cache.service';
import { WorkflowCacheController } from './workflow-cache.controller';

@Global()
@Module({
  providers: [WorkflowCacheService],
  controllers: [WorkflowCacheController],
  exports: [WorkflowCacheService],
})
export class WorkflowCacheModule {}
