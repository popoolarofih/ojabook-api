import { Module } from '@nestjs/common';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { ReceivablesService } from './receivables.service';

@Module({
  controllers: [CustomersController],
  providers: [CustomersService, ReceivablesService],
  exports: [CustomersService, ReceivablesService],
})
export class CustomersModule {}
