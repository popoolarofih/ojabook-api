import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { SalesModule } from '../sales/sales.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [SalesModule, CustomersModule, ExpensesModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
