import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { WorkflowCacheService } from './workflow-cache.service';

@Controller('workflow-cache')
export class WorkflowCacheController {
  constructor(private readonly cache: WorkflowCacheService) {}

  @Post('execution-table')
  async createExecutionTable(@Body() body: { workflowExecutionId: string }) {
    return this.cache.createExecutionTable(body.workflowExecutionId);
  }

  @Post('output')
  async addOutput(
    @Body() body: { workflowExecutionId: string; variableName: string; value: unknown },
  ) {
    await this.cache.addOutputAsCache(
      body.workflowExecutionId,
      body.variableName,
      body.value,
    );
    return { ok: true };
  }

  @Get('entries/:workflowExecutionId')
  async getCacheEntries(@Param('workflowExecutionId') workflowExecutionId: string) {
    return this.cache.getCacheEntries(workflowExecutionId);
  }
}
